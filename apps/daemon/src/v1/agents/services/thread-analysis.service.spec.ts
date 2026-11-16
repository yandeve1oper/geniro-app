import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryService } from '../../memory/services/memory.service';
import type { Project } from '../../projects/entity/project.entity';
import type { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { Run } from '../../runs/entity/run.entity';
import type { RunWire } from '../chat.types';
import { HOST_TEAM_CHANGE_TOOL } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import type { AgentEventBus } from './agent-events.bus';
import type { ChatService } from './chat.service';
import { ThreadAnalysisService } from './thread-analysis.service';

/** The project a run settled into, as `ProjectScopeService.projectOfRun` reads a bound run. */
const STORED_PROJECT = {
  projectOfRun: async (run: Pick<Run, 'projectId'>) =>
    run.projectId ? ({ id: run.projectId } as Project) : null,
} as unknown as ProjectScopeService;

describe('ThreadAnalysisService.start', () => {
  let folder: string;

  beforeEach(() => {
    // Canonical, as the service stores it (`/var` is `/private/var` on macOS).
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'analysis-')));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  function build(
    source: Partial<Run> | null,
    maxSeq = 41,
    earlier: string[] = [],
    memoryOn = true,
  ) {
    // What the thread holds besides `earlier`: the new chat once created, and
    // whatever a racing start made meanwhile.
    const listed: string[] = [];
    const createChat = vi.fn(
      (input: Parameters<ChatService['createChat']>[0]) => {
        listed.unshift('analysis');
        return Promise.resolve({
          id: 'analysis',
          title: input.title,
          status: 'pending',
        } as RunWire);
      },
    );
    const sendMessage = vi.fn((): Promise<unknown> => Promise.resolve({}));
    const remove = vi.fn(() => Promise.resolve({ deleted: true }));
    // The row as it reads after the brief went out — what the popup opens on.
    const findAnalysis = vi.fn(() =>
      Promise.resolve({ id: 'analysis', status: 'running' } as RunWire),
    );
    const deleted = new Subject<string>();
    const sourceRow = (): Run | null =>
      source === null
        ? null
        : ({
            id: 'source',
            title: 'Dev Team run',
            teamId: null,
            cwd: folder,
            archivedAt: null,
            status: 'completed',
            analysisSourceRunId: null,
            analysisTeamSlug: null,
            ...source,
          } as Run);
    const runDao = {
      getById: vi.fn(() => Promise.resolve(sourceRow())),
      // Newest first, as the DAO answers.
      listAnalysesOf: vi.fn(() =>
        Promise.resolve([...listed, ...earlier].map((id) => ({ id }) as Run)),
      ),
      listReviewAnalysesOf: vi.fn(() =>
        Promise.resolve([...listed, ...earlier].map((id) => ({ id }) as Run)),
      ),
      listOrphanedAnalyses: vi.fn(() => Promise.resolve([] as Run[])),
    };
    const itemDao = { maxSeq: vi.fn(() => Promise.resolve(maxSeq)) };
    const service = new ThreadAnalysisService(
      { fork: () => ({}) } as unknown as EntityManager,
      runDao as unknown as RunDao,
      itemDao as unknown as ItemDao,
      {
        createChat,
        sendMessage,
        delete: remove,
        findAnalysis,
      } as unknown as ChatService,
      { allDeleted: () => deleted.asObservable() } as unknown as AgentEventBus,
      { enabled: memoryOn } as MemoryService,
      STORED_PROJECT,
    );
    return {
      service,
      listed,
      createChat,
      sendMessage,
      remove,
      findAnalysis,
      runDao,
      itemDao,
      deleted,
    };
  }

  it('starts the analysis chat on the whole model setup it was given', async () => {
    const { service, createChat } = build({
      projectId: null,
      projectSource: 'none',
    });
    const setup = {
      model: 'opus',
      effort: 'xhigh',
      contextWindow: '1m',
      autoCompactPercent: 80,
      modelParameters: { fast: 'on' },
      configDir: '/profiles/work',
    };

    await service.start('source', { agentKind: 'claude', ...setup });

    expect(createChat.mock.calls[0]![0]).toMatchObject(setup);
  });

  it('an analysis chat inherits the analysed run project, and none explicitly when it has none', async () => {
    const bound = build({ projectId: 'p-billing', projectSource: 'folder' });
    await bound.service.start('source', { agentKind: 'claude' });
    expect(bound.createChat.mock.calls[0]![0].projectId).toBe('p-billing');

    const unbound = build({ projectId: null, projectSource: 'none' });
    await unbound.service.start('source', { agentKind: 'claude' });
    expect(unbound.createChat.mock.calls[0]![0].projectId).toBeNull();
  });

  it('replaces the thread’s earlier analysis once the new one has its brief', async () => {
    const { service, sendMessage, remove, findAnalysis } = build({}, 41, [
      'old-analysis',
    ]);

    const started = await service.start('source', { agentKind: 'claude' });

    expect(remove).toHaveBeenCalledWith('old-analysis');
    expect(remove).not.toHaveBeenCalledWith('analysis');
    // Only after the new one is under way: a start that fails keeps the old.
    expect(remove.mock.invocationCallOrder[0]).toBeGreaterThan(
      sendMessage.mock.invocationCallOrder[0]!,
    );
    // And it answers with its own row as it reads now, not the pre-brief copy.
    expect(started.status).toBe('running');
    expect(findAnalysis).toHaveBeenCalledWith('source', 'analysis');
  });

  it('never replaces a lessons reflection: only the thread’s own analyses are read for the replace', async () => {
    const { service, remove, runDao } = build({}, 41, ['old-review']);
    runDao.listAnalysesOf.mockResolvedValue([
      { id: 'lessons-reflection' },
      { id: 'old-review' },
    ] as Run[]);

    await service.start('source', { agentKind: 'claude' });

    expect(remove.mock.calls).toEqual([['old-review']]);
  });

  it('deletes only what it replaces, so a start racing it keeps its own analysis', async () => {
    const { service, sendMessage, remove, listed } = build({}, 41, ['old']);
    // A second window's start lands while this one's brief goes out.
    sendMessage.mockImplementationOnce(() => {
      listed.unshift('racing');
      return Promise.resolve({});
    });

    await service.start('source', { agentKind: 'claude' });

    expect(remove.mock.calls).toEqual([['old']]);
  });

  it('sweeps at boot the analyses whose thread is already gone, and survives a failed sweep', async () => {
    const { service, runDao, remove } = build({});
    runDao.listOrphanedAnalyses.mockResolvedValueOnce([
      { id: 'orphan-1' },
      { id: 'orphan-2' },
    ] as Run[]);

    service.onApplicationBootstrap();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    expect(remove.mock.calls).toEqual([['orphan-1'], ['orphan-2']]);

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    runDao.listOrphanedAnalyses.mockRejectedValueOnce(new Error('db closed'));
    service.onApplicationBootstrap();
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('keeps the earlier analysis when the new one cannot be started', async () => {
    const { service, sendMessage, remove } = build({}, 41, ['old-analysis']);
    sendMessage.mockRejectedValueOnce(new Error('RUN_NOT_CONFIGURED'));

    await expect(
      service.start('source', { agentKind: 'claude' }),
    ).rejects.toThrow('RUN_NOT_CONFIGURED');
    expect(remove).not.toHaveBeenCalledWith('old-analysis');
  });

  it('deletes a thread’s analysis when the thread itself is deleted', async () => {
    const { service, runDao, remove, deleted } = build({}, 41, [
      'newer',
      'old',
    ]);
    service.onModuleInit();

    deleted.next('source');
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(2));

    expect(runDao.listAnalysesOf).toHaveBeenCalledWith(
      'source',
      expect.anything(),
    );
    expect(remove).toHaveBeenCalledWith('newer');
    expect(remove).toHaveBeenCalledWith('old');
    service.onModuleDestroy();
  });

  it('goes on deleting the rest when one analysis cannot be deleted, and survives a failed lookup', async () => {
    const { service, runDao, remove, deleted } = build({}, 41, [
      'newer',
      'old',
    ]);
    remove.mockRejectedValueOnce(new Error('disk gone'));
    service.onModuleInit();

    deleted.next('source');
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    expect(remove).toHaveBeenLastCalledWith('old');

    // A lookup that fails is logged, never an unhandled rejection.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    runDao.listAnalysesOf.mockRejectedValueOnce(new Error('db closed'));
    deleted.next('source');
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('finds the thread’s analysis, refusing a thread that does not exist', async () => {
    const { service, findAnalysis } = build({});

    await expect(service.find('source')).resolves.toMatchObject({
      id: 'analysis',
    });
    expect(findAnalysis).toHaveBeenCalledWith('source');
    await expect(build(null).service.find('source')).rejects.toMatchObject({
      errorCode: 'RUN_NOT_FOUND',
    });
  });

  it('starts a linked chat with the team guide for a team source', async () => {
    const { service, createChat, sendMessage } = build({
      teamId: 'dev-team',
    });

    await service.start('source', { agentKind: 'claude', model: 'opus' });

    const input = createChat.mock.calls[0]![0];
    expect(input).toMatchObject({
      agentKind: 'claude',
      model: 'opus',
      cwd: folder,
      title: 'Analysis: Dev Team run',
      analysisSource: { runId: 'source', seq: 41, working: false },
    });
    expect(input.taskInstructions).toContain('This is a TEAM thread');
    expect(input.taskInstructions).toContain(HOST_TEAM_CHANGE_TOOL);
    expect(sendMessage).toHaveBeenCalledWith(
      'analysis',
      expect.stringContaining('a team thread'),
    );
  });

  it('hands the analysis chat the user’s reply language', async () => {
    const { service, createChat } = build({ teamId: 'dev-team' });

    await service.start('source', {
      agentKind: 'claude',
      replyLanguage: 'Russian',
    });

    expect(createChat.mock.calls[0]![0].replyLanguage).toBe('Russian');
  });

  it('starts the analysis on auto-approve unless the dialog names a mode', async () => {
    const { service, createChat } = build({});

    await service.start('source', { agentKind: 'claude' });
    await service.start('source', { agentKind: 'claude', approval: 'ask' });

    // Never the chat default `ask`: omitted means `auto`.
    expect(createChat.mock.calls[0]![0].approval).toBe('auto');
    expect(createChat.mock.calls[1]![0].approval).toBe('ask');
  });

  it('records whether the source was still working at the snapshot', async () => {
    const { service, createChat } = build({ status: 'running' });

    await service.start('source', { agentKind: 'claude' });

    expect(createChat.mock.calls[0]![0].analysisSource).toEqual({
      runId: 'source',
      seq: 41,
      working: true,
    });
  });

  it('gives a plain chat the guide without team changes, with the focus appended', async () => {
    const { service, createChat } = build({});

    await service.start('source', {
      agentKind: 'codex',
      focus: 'why so many re-reads?',
    });

    const guide = createChat.mock.calls[0]![0].taskInstructions!;
    expect(guide).toContain('Never recommend a team change');
    expect(guide).not.toContain(HOST_TEAM_CHANGE_TOOL);
    expect(guide).toContain('why so many re-reads?');
  });

  it('briefs an analysis without the memory target while the shared memory is off', async () => {
    const off = build({}, 41, [], false);
    const on = build({});

    await off.service.start('source', { agentKind: 'codex' });
    await on.service.start('source', { agentKind: 'codex' });

    expect(on.createChat.mock.calls[0]![0].taskInstructions).toContain('M-1');
    expect(off.createChat.mock.calls[0]![0].taskInstructions).not.toContain(
      'M-1',
    );
  });

  it("refuses with ANALYSIS_FOLDER_GONE when the source's folder is gone, and runs in a folder sent instead", async () => {
    const { service, createChat } = build({ cwd: join(folder, 'deleted') });

    await expect(
      service.start('source', { agentKind: 'claude' }),
    ).rejects.toMatchObject({ errorCode: 'ANALYSIS_FOLDER_GONE' });
    expect(createChat).not.toHaveBeenCalled();

    await service.start('source', { agentKind: 'claude', cwd: folder });
    expect(createChat.mock.calls[0]![0].cwd).toBe(folder);
  });

  it('re-reads until no row lands between the status and the snapshot', async () => {
    const { service, createChat, runDao, itemDao } = build({});
    const at = (status: string) => ({
      id: 'source',
      title: 'Dev Team run',
      teamId: null,
      cwd: folder,
      archivedAt: null,
      status,
      analysisSourceRunId: null,
      analysisTeamSlug: null,
    });
    runDao.getById
      .mockResolvedValueOnce(at('completed') as never)
      .mockResolvedValueOnce(at('completed') as never)
      .mockResolvedValueOnce(at('running') as never);
    itemDao.maxSeq
      .mockResolvedValueOnce(40)
      .mockResolvedValueOnce(41)
      .mockResolvedValue(41);

    await service.start('source', { agentKind: 'claude' });

    expect(createChat.mock.calls[0]![0].analysisSource).toEqual({
      runId: 'source',
      seq: 41,
      working: true,
    });
    // Each status read uses its own fork, so no identity map answers it.
    const forks = runDao.getById.mock.calls.map(
      (call) => (call as unknown[])[1],
    );
    expect(new Set(forks).size).toBe(forks.length);
  });

  it("refuses a folder the user picked with that folder's own reason", async () => {
    const { service, createChat } = build({ cwd: join(folder, 'deleted') });
    const picked = join(folder, 'nope');

    await expect(
      service.start('source', { agentKind: 'claude', cwd: picked }),
    ).rejects.toMatchObject({
      errorCode: 'ANALYSIS_FOLDER_GONE',
      message: expect.stringContaining(picked),
    });
    expect(createChat).not.toHaveBeenCalled();
  });

  it('removes the new chat when its brief cannot be sent, and says why', async () => {
    const { service, sendMessage, remove } = build({});
    sendMessage.mockRejectedValueOnce(new Error('RUN_NOT_CONFIGURED'));

    await expect(
      service.start('source', { agentKind: 'claude' }),
    ).rejects.toThrow('RUN_NOT_CONFIGURED');
    expect(remove).toHaveBeenCalledWith('analysis');
  });

  it('starts on an archived source as on a live one, up to its newest row', async () => {
    const { service, createChat, sendMessage } = build({
      archivedAt: new Date(),
      status: 'cancelled',
    });

    await expect(
      service.start('source', { agentKind: 'claude' }),
    ).resolves.toMatchObject({ id: 'analysis' });

    expect(createChat.mock.calls[0]![0].analysisSource).toEqual({
      runId: 'source',
      seq: 41,
      working: false,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses an analysis of an analysis', async () => {
    await expect(
      build({ analysisSourceRunId: 'other' }).service.start('source', {
        agentKind: 'claude',
      }),
    ).rejects.toMatchObject({ errorCode: 'ANALYSIS_OF_ANALYSIS' });
    await expect(
      build({ analysisTeamSlug: 'team' }).service.start('source', {
        agentKind: 'claude',
      }),
    ).rejects.toMatchObject({ errorCode: 'ANALYSIS_OF_ANALYSIS' });
  });

  it('refuses a source with no rows, and one that does not exist', async () => {
    await expect(
      build({}, -1).service.start('source', { agentKind: 'claude' }),
    ).rejects.toMatchObject({ errorCode: 'ANALYSIS_SOURCE_EMPTY' });
    await expect(
      build(null).service.start('source', { agentKind: 'claude' }),
    ).rejects.toMatchObject({ errorCode: 'RUN_NOT_FOUND' });
  });
});

describe('ThreadAnalysisService.startTeam', () => {
  let folder: string;

  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'wf-analysis-')));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  function build(
    runs: Partial<Run>[],
    seqs: Record<string, number>,
    earlier: string[] = [],
  ) {
    const listed: string[] = [];
    const createChat = vi.fn(
      (input: Parameters<ChatService['createChat']>[0]) => {
        listed.unshift('analysis');
        return Promise.resolve({
          id: 'analysis',
          title: input.title,
          status: 'pending',
        } as RunWire);
      },
    );
    const sendMessage = vi.fn((): Promise<unknown> => Promise.resolve({}));
    const remove = vi.fn(() => Promise.resolve({ deleted: true }));
    const findTeamAnalysis = vi.fn(() =>
      Promise.resolve({ id: 'analysis', status: 'running' } as RunWire),
    );
    const rows = runs.map(
      (run) =>
        ({
          status: 'completed',
          cwd: folder,
          createdAt: new Date(0),
          ...run,
        }) as Run,
    );
    const runDao = {
      getById: vi.fn((id: string) =>
        Promise.resolve(rows.find((run) => run.id === id) ?? null),
      ),
      newestTeamRuns: vi.fn((_slug: string, limit: number) =>
        Promise.resolve(rows.slice(0, limit)),
      ),
      listTeamAnalyses: vi.fn(() =>
        Promise.resolve([...listed, ...earlier].map((id) => ({ id }) as Run)),
      ),
    };
    const itemDao = {
      maxSeq: vi.fn((runId: string) => Promise.resolve(seqs[runId] ?? -1)),
    };
    const service = new ThreadAnalysisService(
      { fork: () => ({}) } as unknown as EntityManager,
      runDao as unknown as RunDao,
      itemDao as unknown as ItemDao,
      {
        createChat,
        sendMessage,
        delete: remove,
        findTeamAnalysis,
      } as unknown as ChatService,
      {
        allDeleted: () => new Subject<string>().asObservable(),
      } as unknown as AgentEventBus,
      { enabled: true } as MemoryService,
      STORED_PROJECT,
    );
    return { service, createChat, sendMessage, remove, runDao };
  }

  const TARGET = { slug: 'team', name: 'Dev Team' };

  it('gives a team analysis the one project its runs share, and none when they span projects', async () => {
    const shared = build(
      [
        { id: 'r2', projectId: 'p-billing' },
        { id: 'r1', projectId: 'p-billing' },
      ],
      { r2: 5, r1: 5 },
    );
    await shared.service.startTeam(TARGET, { agentKind: 'claude', runs: 2 });
    expect(shared.createChat.mock.calls[0]![0].projectId).toBe('p-billing');

    const spanning = build(
      [
        { id: 'r2', projectId: 'p-billing' },
        { id: 'r1', projectId: 'p-shop' },
      ],
      { r2: 5, r1: 5 },
    );
    await spanning.service.startTeam(TARGET, { agentKind: 'claude', runs: 2 });
    expect(spanning.createChat.mock.calls[0]![0].projectId).toBeNull();
  });

  it('reads the newest runs up to the count, each at its own snapshot, skipping an empty one', async () => {
    const { service, createChat, sendMessage, runDao } = build(
      [
        { id: 'r3', status: 'running' },
        { id: 'r2' },
        { id: 'r1' },
        { id: 'r0' },
      ],
      { r3: 12, r2: -1, r1: 40, r0: 7 },
    );

    await service.startTeam(TARGET, {
      agentKind: 'claude',
      runs: 3,
      focus: 'cheaper',
    });

    expect(runDao.newestTeamRuns).toHaveBeenCalledWith(
      'team',
      3,
      expect.anything(),
    );
    const input = createChat.mock.calls[0]![0];
    expect(input.analysisTeam).toEqual({
      slug: 'team',
      runs: [
        { runId: 'r3', snapshotSeq: 12, working: true },
        { runId: 'r1', snapshotSeq: 40, working: false },
      ],
    });
    expect(input.analysisSource).toBeUndefined();
    expect(input.title).toBe('Analysis: Dev Team');
    expect(input.cwd).toBe(folder);
    expect(input.approval).toBe('auto');
    expect(input.taskInstructions).toContain('# Team analysis');
    expect(input.taskInstructions).toContain('cheaper');
    expect(sendMessage).toHaveBeenCalledWith(
      'analysis',
      expect.stringContaining('across its 2 latest runs'),
    );
  });

  it('replaces the team’s earlier analysis only once the new one has its brief', async () => {
    const { service, sendMessage, remove } = build([{ id: 'r1' }], { r1: 3 }, [
      'old',
    ]);

    const started = await service.startTeam(TARGET, {
      agentKind: 'claude',
      runs: 5,
    });

    expect(remove).toHaveBeenCalledWith('old');
    expect(remove).not.toHaveBeenCalledWith('analysis');
    expect(remove.mock.invocationCallOrder[0]).toBeGreaterThan(
      sendMessage.mock.invocationCallOrder[0]!,
    );
    expect(started.status).toBe('running');
  });

  it('refuses a team with nothing to read, and keeps the old analysis', async () => {
    const { service, createChat, remove } = build([{ id: 'r1' }], { r1: -1 }, [
      'old',
    ]);

    await expect(
      service.startTeam(TARGET, { agentKind: 'claude', runs: 5 }),
    ).rejects.toMatchObject({ errorCode: 'ANALYSIS_NO_RUNS' });
    expect(createChat).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("runs in the newest run with rows' own folder, or the folder sent, and asks for one when that run's is gone", async () => {
    const own = realpathSync(mkdtempSync(join(tmpdir(), 'wf-newest-')));
    const picked = realpathSync(mkdtempSync(join(tmpdir(), 'wf-picked-')));
    try {
      // The newest run wrote nothing, so the run read first is the next one.
      const runs = [
        { id: 'empty', cwd: folder },
        { id: 'r1', cwd: own },
      ];
      const first = build(runs, { empty: -1, r1: 2 });
      await first.service.startTeam(TARGET, {
        agentKind: 'claude',
        runs: 2,
      });
      expect(first.createChat.mock.calls[0]![0].cwd).toBe(own);

      const sent = build(runs, { empty: -1, r1: 2 });
      await sent.service.startTeam(TARGET, {
        agentKind: 'claude',
        runs: 2,
        cwd: picked,
      });
      expect(sent.createChat.mock.calls[0]![0].cwd).toBe(picked);

      const gone = build([{ id: 'r1', cwd: join(own, 'gone') }], { r1: 2 });
      await expect(
        gone.service.startTeam(TARGET, { agentKind: 'claude', runs: 1 }),
      ).rejects.toMatchObject({ errorCode: 'ANALYSIS_FOLDER_GONE' });
      expect(gone.createChat).not.toHaveBeenCalled();
    } finally {
      rmSync(own, { recursive: true, force: true });
      rmSync(picked, { recursive: true, force: true });
    }
  });

  it('deletes exactly the analyses its team has', async () => {
    const { service, remove, runDao } = build([], {}, ['a1', 'a2']);

    await service.deleteTeamAnalyses('team');

    expect(runDao.listTeamAnalyses).toHaveBeenCalledWith(
      'team',
      expect.anything(),
    );
    expect(remove.mock.calls).toEqual([['a1'], ['a2']]);
  });

  it('removes the new chat when its brief cannot be sent', async () => {
    const { service, sendMessage, remove } = build([{ id: 'r1' }], { r1: 2 }, [
      'old',
    ]);
    sendMessage.mockRejectedValueOnce(new Error('RUN_BUSY'));

    await expect(
      service.startTeam(TARGET, { agentKind: 'claude', runs: 1 }),
    ).rejects.toThrow('RUN_BUSY');
    expect(remove).toHaveBeenCalledWith('analysis');
    expect(remove).not.toHaveBeenCalledWith('old');
  });

  it("runs in the newest sampled run's folder when that folder is gone, and in the next one that exists", async () => {
    const own = realpathSync(mkdtempSync(join(tmpdir(), 'wf-older-')));
    try {
      const { service, createChat } = build(
        [
          { id: 'r2', cwd: join(own, 'gone') },
          { id: 'r1', cwd: own },
        ],
        { r2: 9, r1: 4 },
      );

      await service.startTeam(TARGET, { agentKind: 'claude', runs: 2 });

      expect(createChat.mock.calls[0]![0].cwd).toBe(own);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('refuses ANALYSIS_FOLDER_GONE when no sampled run has a folder that is still there', async () => {
    const { service, createChat } = build(
      [
        { id: 'r2', cwd: join(folder, 'gone-2') },
        { id: 'r1', cwd: join(folder, 'gone-1') },
      ],
      { r2: 9, r1: 4 },
    );

    await expect(
      service.startTeam(TARGET, { agentKind: 'claude', runs: 2 }),
    ).rejects.toMatchObject({ errorCode: 'ANALYSIS_FOLDER_GONE' });
    expect(createChat).not.toHaveBeenCalled();
  });
});
