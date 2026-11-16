import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../environments';
import type { RunStatusEvent } from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import type { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ChatService } from '../../agents/services/chat.service';
import type { EffortsService } from '../../agents/services/efforts.service';
import type { MemoryService } from '../../memory/services/memory.service';
import type { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { Run } from '../../runs/entity/run.entity';
import type { LessonProposalDao } from '../dao/lesson-proposal.dao';
import type { LessonSegmentDao } from '../dao/lesson-segment.dao';
import {
  DEFAULT_LESSONS_CONFIG,
  type LessonModelChoice,
  type LessonsConfig,
} from '../lessons.types';
import { LessonReflectionService } from './lesson-reflection.service';
import { LessonsConfigService } from './lessons-config.service';
import { LessonsEventBus } from './lessons-events.bus';

type Item = {
  seq: number;
  kind: string;
  role: string | null;
  payload: string;
};

const SNAPSHOT_SEQ = 9;

function userMessage(seq: number, text: string): Item {
  return {
    seq,
    kind: 'message',
    role: 'user',
    payload: JSON.stringify({ text }),
  };
}

function turnComplete(seq: number): Item {
  return { seq, kind: 'turn_complete', role: null, payload: '{}' };
}

function runOf(overrides: Partial<Run>): Run {
  return {
    id: 'src',
    title: 'Migrate the cache',
    teamId: null,
    projectId: null,
    projectSource: 'none',
    cwd: null,
    status: 'completed',
    agentKind: 'claude',
    configDir: null,
    analysisSourceRunId: null,
    analysisTeamSlug: null,
    editsTeamSlug: null,
    editsProjectId: null,
    reflectedThroughSeq: null,
    pendingDeleteAt: null,
    archivedAt: null,
    ...overrides,
  } as unknown as Run;
}

const QUEUED = {
  id: 'seg-q',
  runId: 'src',
  status: 'queued',
  attempts: 1,
  fromSeq: -1,
  toSeq: 4,
  closedBy: 'archive',
};

function choiceOf(overrides: Partial<LessonModelChoice>): LessonModelChoice {
  return {
    agent: 'claude',
    configDir: null,
    model: null,
    effort: null,
    contextWindow: null,
    modelParameters: {},
    ...overrides,
  };
}

function build(
  options: {
    source?: Partial<Run>;
    maxSeq?: number;
    /** The newest row that is not a lessons row; defaults to `maxSeq`. */
    newestOwn?: number;
    /** The thread's queued stretch, as `queuedOf` finds it. */
    queued?: Record<string, unknown> | null;
    /** The stretch a reflection run belongs to, as `ofReflection` finds it. */
    reflectionSegment?: Record<string, unknown> | null;
    items?: Item[];
    running?: Partial<Run>[];
    project?: { id: string; folder: string } | null;
    config?: Partial<LessonsConfig>;
    /** The light model each CLI offers, as its adapter reports it. */
    lightModels?: Record<string, string | null>;
    /** The efforts the CLIs accept; none by default. */
    acceptsEffort?: boolean;
    runItems?: Item[];
    rejected?: { title: string; rejectReason: string | null }[];
    sendFails?: Error;
    createFails?: Error;
  } = {},
) {
  const source = runOf(options.source ?? {});
  const maxSeq = options.maxSeq ?? SNAPSHOT_SEQ;
  const items = options.items ?? [];
  const em = { fork: () => em } as unknown as EntityManager;
  const runDao = {
    getById: vi.fn(() => Promise.resolve(source)),
    listLessonReflectionsOf: vi.fn(() =>
      Promise.resolve((options.running ?? []).map((run) => runOf(run))),
    ),
  };
  const itemDao = {
    maxSeq: vi.fn(() => Promise.resolve(maxSeq)),
    getByRun: vi.fn(() => Promise.resolve(options.runItems ?? [])),
    maxSeqExcept: vi.fn(() => Promise.resolve(options.newestOwn ?? maxSeq)),
    analysisPage: vi.fn(
      (
        _runId: string,
        page: {
          afterSeq: number;
          maxSeq: number;
          limit: number;
          kinds?: readonly string[];
        },
      ) =>
        Promise.resolve(
          items
            .filter(
              (item) =>
                item.seq > page.afterSeq &&
                item.seq <= page.maxSeq &&
                (page.kinds === undefined || page.kinds.includes(item.kind)),
            )
            .slice(0, page.limit),
        ),
    ),
  };
  const chats = {
    createChat: vi.fn((_input: Record<string, unknown>) =>
      options.createFails === undefined
        ? Promise.resolve({ id: 'refl-run' })
        : Promise.reject(options.createFails),
    ),
    sendMessage: vi.fn((_runId: string, _brief: string) =>
      options.sendFails === undefined
        ? Promise.resolve({})
        : Promise.reject(options.sendFails),
    ),
    delete: vi.fn((_runId: string) => Promise.resolve({ deleted: true })),
    cancel: vi.fn((_runId: string) => Promise.resolve()),
  };
  const segments = {
    create: vi.fn((input: Record<string, unknown>) =>
      Promise.resolve({ id: 'seg-1', ...input }),
    ),
    updateById: vi.fn(() => Promise.resolve()),
    deleteOfRuns: vi.fn((_runIds: readonly string[], _em: unknown) =>
      Promise.resolve(),
    ),
    queuedOf: vi.fn(() => Promise.resolve(options.queued ?? null)),
    ofReflection: vi.fn(() =>
      Promise.resolve(options.reflectionSegment ?? null),
    ),
  };
  const deleted = new Subject<string>();
  const statuses = new Subject<RunStatusEvent>();
  const proposals = {
    rejectedIn: vi.fn(() => Promise.resolve(options.rejected ?? [])),
  };
  const projectScope = {
    projectOfRun: vi.fn(() => Promise.resolve(options.project ?? null)),
  };
  const adapters = {
    for: (agent: string) => ({
      getConfig: () => ({ lightModel: options.lightModels?.[agent] ?? null }),
    }),
  };
  const efforts = { accepts: () => options.acceptsEffort ?? false };
  const config = new LessonsConfigService(
    adapters as unknown as AgentAdapterRegistry,
    efforts as unknown as EffortsService,
  );
  config.set({ ...DEFAULT_LESSONS_CONFIG, ...options.config });
  const events = new LessonsEventBus();
  const service = new LessonReflectionService(
    em,
    runDao as unknown as RunDao,
    itemDao as unknown as ItemDao,
    chats as unknown as ChatService,
    {
      allDeleted: () => deleted.asObservable(),
      allStatuses: () => statuses.asObservable(),
    } as unknown as AgentEventBus,
    { enabled: true } as MemoryService,
    projectScope as unknown as ProjectScopeService,
    segments as unknown as LessonSegmentDao,
    proposals as unknown as LessonProposalDao,
    config,
    events,
  );
  return {
    service,
    em,
    events,
    runDao,
    itemDao,
    chats,
    segments,
    proposals,
    projectScope,
    deleted,
    statuses,
  };
}

describe('LessonReflectionService.start', () => {
  let folder: string;

  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'lessons-')));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it.each([
    ['the watermark is the newest row', 9, 9],
    ['the thread holds fewer rows than the watermark', 9, 7],
  ])(
    'refuses a reflection when %s, starting no chat',
    async (_, reflectedThroughSeq, maxSeq) => {
      const fixture = build({
        source: { reflectedThroughSeq },
        maxSeq,
      });

      await expect(fixture.service.start('src', {})).rejects.toMatchObject({
        errorCode: 'LESSONS_NOTHING_NEW',
      });
      expect(fixture.chats.createChat).not.toHaveBeenCalled();
    },
  );

  it('refuses a second reflection while one on the thread is still working', async () => {
    const fixture = build({
      running: [{ id: 'r1', status: 'running' }],
    });

    await expect(fixture.service.start('src', {})).rejects.toMatchObject({
      errorCode: 'LESSONS_REFLECTING',
    });
    expect(fixture.chats.createChat).not.toHaveBeenCalled();
  });

  it('refuses a reflection whose only rows past the watermark are the lessons card and its outcomes', async () => {
    const { service, chats } = build({
      source: { reflectedThroughSeq: SNAPSHOT_SEQ },
      maxSeq: SNAPSHOT_SEQ + 3,
      newestOwn: SNAPSHOT_SEQ,
    });

    await expect(service.start('src-run', {})).rejects.toMatchObject({
      errorCode: 'LESSONS_NOTHING_NEW',
    });
    expect(chats.createChat).not.toHaveBeenCalled();
    expect((await service.state('src-run')).reflectable).toBe(false);
  });

  it('starts a new reflection once the earlier one has finished', async () => {
    const fixture = build({
      running: [{ id: 'r0', status: 'completed' }],
    });

    await fixture.service.start('src', {});

    expect(fixture.chats.createChat).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an analysis', { analysisSourceRunId: 'other' }],
    ['a team analysis', { analysisTeamSlug: 'team-a' }],
    ['a team builder chat', { editsTeamSlug: 'team-a' }],
    ['a project chat', { editsProjectId: 'p1' }],
  ])('refuses to reflect on %s, starting no chat', async (_, source) => {
    const fixture = build({ source });

    await expect(fixture.service.start('src', {})).rejects.toMatchObject({
      errorCode: 'LESSONS_NOT_REFLECTABLE',
    });
    expect(fixture.chats.createChat).not.toHaveBeenCalled();
  });

  it('starts a hidden lessons chat on the thread and deletes nothing', async () => {
    const fixture = build({ source: { cwd: folder } });

    const started = await fixture.service.start('src', {});

    expect(started).toEqual({
      reflectionRunId: 'refl-run',
      segmentId: 'seg-1',
      fromSeq: -1,
      toSeq: SNAPSHOT_SEQ,
    });
    expect(fixture.chats.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'claude',
        cwd: folder,
        projectId: null,
        approval: 'ask',
        title: 'Lessons: Migrate the cache',
        taskInstructions: expect.stringContaining('# Lessons reflection'),
        analysisSource: {
          runId: 'src',
          seq: SNAPSHOT_SEQ,
          working: false,
          purpose: 'lessons',
        },
      }),
    );
    expect(fixture.segments.create).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'src',
        fromSeq: -1,
        toSeq: SNAPSHOT_SEQ,
        closedBy: 'manual',
        status: 'reflecting',
      }),
      fixture.em,
    );
    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-1',
      { reflectionRunId: 'refl-run' },
      fixture.em,
    );
    expect(fixture.chats.delete).not.toHaveBeenCalled();
  });

  it('sends a brief that names the stretch, the signals found and the rejected lessons', async () => {
    const fixture = build({
      source: { reflectedThroughSeq: 0 },
      maxSeq: 3,
      items: [
        turnComplete(1),
        userMessage(2, 'no, that is wrong'),
        userMessage(3, 'thanks'),
      ],
      rejected: [{ title: 'Old rule', rejectReason: 'too broad' }],
    });

    await fixture.service.start('src', {});

    const [runId, brief] = fixture.chats.sendMessage.mock.calls[0]!;
    expect(runId).toBe('refl-run');
    expect(brief).toContain('the items after seq 0 up to and including seq 3');
    expect(brief).toContain('- seq 2 · user_correction · "no, that is wrong"');
    expect(brief).toContain('- "Old rule" — reason: "too broad"');
  });

  it('tells the reflection that the daemon found no signal when a correction follows no finished turn', async () => {
    const fixture = build({
      items: [userMessage(2, 'no, that is wrong')],
    });

    await fixture.service.start('src', {});

    const [, brief] = fixture.chats.sendMessage.mock.calls[0]!;
    expect(brief).toContain('The daemon found no learning signal');
  });

  it('takes the agent, model and effort the input names over the reflector', async () => {
    const fixture = build({
      config: {
        mode: 'auto',
        reflector: choiceOf({
          agent: 'claude',
          model: 'haiku',
          effort: 'low',
          configDir: '/profiles/reflector',
        }),
      },
    });

    await fixture.service.start('src', {
      agentKind: 'codex',
      model: 'gpt-5',
      effort: 'medium',
      configDir: '/profiles/press',
    });

    expect(fixture.chats.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'codex',
        model: 'gpt-5',
        effort: 'medium',
        configDir: '/profiles/press',
      }),
    );
  });

  it('runs as the reflector, profile included, when the input names nothing', async () => {
    const fixture = build({
      source: { agentKind: 'claude', configDir: '/profiles/thread' },
      config: {
        mode: 'auto',
        reflector: choiceOf({
          agent: 'codex',
          model: 'o3',
          effort: 'low',
          configDir: '/profiles/reflector',
          contextWindow: '200k',
          modelParameters: { verbosity: 'low' },
        }),
      },
    });

    await fixture.service.start('src', {});

    expect(fixture.chats.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'codex',
        model: 'o3',
        effort: 'low',
        configDir: '/profiles/reflector',
        contextWindow: '200k',
        modelParameters: { verbosity: 'low' },
      }),
    );
  });

  it('keeps the reflector’s effort when the input names only a model on the reflector’s CLI', async () => {
    const fixture = build({
      config: {
        mode: 'auto',
        reflector: choiceOf({ agent: 'codex', model: 'o3', effort: 'low' }),
      },
    });

    await fixture.service.start('src', { model: 'gpt-5' });

    expect(fixture.chats.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'codex',
        model: 'gpt-5',
        effort: 'low',
      }),
    );
  });

  it('drops the reflector’s model, effort and profile when the input switches to another agent', async () => {
    const fixture = build({
      source: { agentKind: 'codex' },
      lightModels: { claude: 'claude-light' },
      acceptsEffort: true,
      config: {
        mode: 'auto',
        reflector: choiceOf({
          agent: 'codex',
          model: 'o3',
          effort: 'low',
          configDir: '/profiles/reflector',
          contextWindow: '200k',
          modelParameters: { verbosity: 'low' },
        }),
      },
    });

    await fixture.service.start('src', { agentKind: 'claude' });

    const input = fixture.chats.createChat.mock.calls[0]![0];
    expect(input).toMatchObject({
      agentKind: 'claude',
      model: 'claude-light',
      effort: 'high',
    });
    expect(input.configDir).toBeUndefined();
    expect(input.contextWindow).toBeUndefined();
    expect(input.modelParameters).toBeUndefined();
  });

  it('with no reflector runs as the thread: its CLI and profile on that CLI’s light model at high effort', async () => {
    const fixture = build({
      source: { agentKind: 'codex', configDir: '/profiles/thread' },
      lightModels: { codex: 'codex-light', claude: 'claude-light' },
      acceptsEffort: true,
    });

    await fixture.service.start('src', {});

    expect(fixture.chats.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'codex',
        model: 'codex-light',
        effort: 'high',
        configDir: '/profiles/thread',
      }),
    );
  });

  it('with no reflector sets no effort when the light model does not accept high', async () => {
    const fixture = build({
      lightModels: { claude: 'claude-light' },
      acceptsEffort: false,
    });

    await fixture.service.start('src', {});

    const input = fixture.chats.createChat.mock.calls[0]![0];
    expect(input).toMatchObject({ agentKind: 'claude', model: 'claude-light' });
    expect(input.effort).toBeUndefined();
  });

  it('keeps the thread’s config folder only for the agent that wrote it', async () => {
    const same = build({ source: { configDir: '/profiles/work' } });
    const other = build({ source: { configDir: '/profiles/work' } });

    await same.service.start('src', {});
    await other.service.start('src', { agentKind: 'codex' });

    expect(same.chats.createChat.mock.calls[0]![0]).toMatchObject({
      configDir: '/profiles/work',
    });
    expect(other.chats.createChat.mock.calls[0]![0].configDir).toBeUndefined();
  });

  it('runs in the thread’s own folder when it still exists', async () => {
    const fixture = build({ source: { cwd: folder } });

    await fixture.service.start('src', {});

    expect(fixture.chats.createChat.mock.calls[0]![0]).toMatchObject({
      cwd: folder,
    });
  });

  it('falls back to the project folder when the thread’s folder is gone', async () => {
    const projectFolder = realpathSync(
      mkdtempSync(join(tmpdir(), 'lessons-project-')),
    );
    try {
      const fixture = build({
        source: { cwd: join(folder, 'gone'), projectId: 'p1' },
        project: { id: 'p1', folder: projectFolder },
      });

      await fixture.service.start('src', {});

      expect(fixture.chats.createChat.mock.calls[0]![0]).toMatchObject({
        cwd: projectFolder,
        projectId: 'p1',
      });
    } finally {
      rmSync(projectFolder, { recursive: true, force: true });
    }
  });

  it('falls back to the app data folder when neither folder exists', async () => {
    const fixture = build({
      source: { cwd: join(folder, 'gone') },
      project: { id: 'p1', folder: join(folder, 'also-gone') },
    });

    await fixture.service.start('src', {});

    expect(fixture.chats.createChat.mock.calls[0]![0]).toMatchObject({
      cwd: environment.userDataDir,
    });
  });

  it('deletes the new chat and puts its stretch back in the queue with the reason when the brief cannot be sent', async () => {
    const fixture = build({ sendFails: new Error('boom') });

    await expect(fixture.service.start('src', {})).rejects.toThrow('boom');

    expect(fixture.chats.delete).toHaveBeenCalledWith('refl-run');
    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-1',
      { status: 'queued', failReason: 'boom', leaseUntil: null },
      fixture.em,
    );
  });

  it('leaves a stretch failed with the reason once its last attempt cannot send the brief', async () => {
    const fixture = build({
      queued: { ...QUEUED, attempts: 2 },
      sendFails: new Error('boom'),
    });

    await expect(fixture.service.start('src', {})).rejects.toThrow('boom');

    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-q',
      { status: 'failed', failReason: 'boom', leaseUntil: null },
      fixture.em,
    );
  });

  it('queues the segment again with the reason and announces it when the chat cannot be created', async () => {
    const fixture = build({ createFails: new Error('no agent') });
    const announced: (string | null)[] = [];
    fixture.events
      .allChanges()
      .subscribe((event) => announced.push(event.runId));

    await expect(fixture.service.start('src', {})).rejects.toThrow('no agent');

    expect(fixture.chats.sendMessage).not.toHaveBeenCalled();
    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-1',
      { status: 'queued', failReason: 'no agent', leaseUntil: null },
      fixture.em,
    );
    expect(announced).toEqual(['src']);
  });

  it('announces the started reflection on its thread', async () => {
    const fixture = build();
    const announced: (string | null)[] = [];
    fixture.events
      .allChanges()
      .subscribe((event) => announced.push(event.runId));

    await fixture.service.start('src', {});

    expect(announced).toEqual(['src']);
  });
});

describe('LessonReflectionService — review findings', () => {
  it('reads the signals of a stretch past its first page of 500 rows', async () => {
    const items = Array.from({ length: 520 }, (_, index) => index + 1).map(
      (seq) =>
        seq === 510 ? userMessage(510, 'no, that is wrong') : turnComplete(seq),
    );
    const fixture = build({ maxSeq: 520, items });

    await fixture.service.start('src', {});

    const [, brief] = fixture.chats.sendMessage.mock.calls[0]!;
    expect(brief).toContain(
      '- seq 510 · user_correction · "no, that is wrong"',
    );
  });

  it('finds a correction that opens a stretch after a reflected one, which starts on a finished turn', async () => {
    const fixture = build({
      source: { reflectedThroughSeq: 9 },
      maxSeq: 10,
      items: [userMessage(10, 'no, that is wrong')],
    });

    await fixture.service.start('src', {});

    const [, brief] = fixture.chats.sendMessage.mock.calls[0]!;
    expect(brief).toContain('- seq 10 · user_correction · "no, that is wrong"');
  });

  it('lets one of two simultaneous starts through and refuses the other as already reflecting', async () => {
    const fixture = build();

    const [first, second] = await Promise.allSettled([
      fixture.service.start('src', {}),
      fixture.service.start('src', {}),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({
      status: 'rejected',
      reason: { errorCode: 'LESSONS_REFLECTING' },
    });
    expect(fixture.chats.createChat).toHaveBeenCalledTimes(1);
  });

  it('falls back to the thread’s own agent when the reflector names an agent this app does not know', async () => {
    const fixture = build({
      source: { agentKind: 'claude' },
      lightModels: { claude: 'claude-light' },
      config: {
        mode: 'auto',
        reflector: choiceOf({
          agent: 'mystery-cli',
          model: 'haiku',
          effort: 'low',
        }),
      },
    });

    await fixture.service.start('src', {});

    const input = fixture.chats.createChat.mock.calls[0]![0];
    expect(input).toMatchObject({ agentKind: 'claude', model: 'claude-light' });
    expect(input.effort).toBeUndefined();
  });

  it('drops the segments of a run when the run is deleted, and stops listening once destroyed', () => {
    const fixture = build();

    fixture.service.onModuleInit();
    fixture.deleted.next('run-gone');
    fixture.service.onModuleDestroy();
    fixture.deleted.next('run-later');

    expect(fixture.segments.deleteOfRuns).toHaveBeenCalledTimes(1);
    expect(fixture.segments.deleteOfRuns).toHaveBeenCalledWith(
      ['run-gone'],
      fixture.em,
    );
  });
});

describe('LessonReflectionService.state', () => {
  it('is reflectable only when something past the watermark exists', async () => {
    const nothing = build({
      source: { reflectedThroughSeq: SNAPSHOT_SEQ },
      maxSeq: SNAPSHOT_SEQ,
    });
    const something = build({
      source: { reflectedThroughSeq: SNAPSHOT_SEQ },
      maxSeq: SNAPSHOT_SEQ + 1,
    });

    expect(await nothing.service.state('src')).toEqual({
      reflectable: false,
      reflectionRunId: null,
      reflectedThroughSeq: SNAPSHOT_SEQ,
    });
    expect(await something.service.state('src')).toEqual({
      reflectable: true,
      reflectionRunId: null,
      reflectedThroughSeq: SNAPSHOT_SEQ,
    });
  });

  it('is not reflectable while a reflection on the thread still runs, and names it', async () => {
    const fixture = build({
      maxSeq: SNAPSHOT_SEQ + 1,
      running: [{ id: 'r1', status: 'running' }],
    });

    expect(await fixture.service.state('src')).toMatchObject({
      reflectable: false,
      reflectionRunId: 'r1',
    });
  });

  it('is never reflectable for an analysis, whatever is past the watermark', async () => {
    const fixture = build({
      source: { analysisSourceRunId: 'other' },
      maxSeq: SNAPSHOT_SEQ + 1,
    });

    expect(await fixture.service.state('src')).toMatchObject({
      reflectable: false,
    });
  });

  it('is never reflectable on a thread being deleted, whatever is past the watermark', async () => {
    const fixture = build({
      source: { pendingDeleteAt: new Date() },
      maxSeq: SNAPSHOT_SEQ + 1,
    });

    expect(await fixture.service.state('src')).toEqual({
      reflectable: false,
      reflectionRunId: null,
      reflectedThroughSeq: null,
    });
  });
});

describe('LessonReflectionService.start on a queued stretch', () => {
  it('takes the thread’s queued stretch: no new row, one more attempt, reflecting with a lease and the closer it was queued with', async () => {
    const fixture = build({ queued: { ...QUEUED } });

    const started = await fixture.service.start('src', {});

    expect(started.segmentId).toBe('seg-q');
    expect(fixture.segments.create).not.toHaveBeenCalled();
    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-q',
      expect.objectContaining({
        status: 'reflecting',
        attempts: 2,
        reflectionRunId: null,
        checkRunId: null,
        failReason: null,
        leaseUntil: expect.any(Date),
      }),
      fixture.em,
    );
    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-q',
      { reflectionRunId: 'refl-run' },
      fixture.em,
    );
    expect(fixture.segments.updateById).not.toHaveBeenCalledWith(
      'seg-q',
      expect.objectContaining({ closedBy: expect.anything() }),
      fixture.em,
    );
  });

  it('reads from the thread’s watermark to the current end, not the span it was queued with', async () => {
    const fixture = build({
      source: { reflectedThroughSeq: 2 },
      queued: { ...QUEUED, fromSeq: 0, toSeq: 4 },
    });

    const started = await fixture.service.start('src', {});

    expect(started).toEqual(
      expect.objectContaining({ fromSeq: 2, toSeq: SNAPSHOT_SEQ }),
    );
    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-q',
      expect.objectContaining({ fromSeq: 2, toSeq: SNAPSHOT_SEQ }),
      fixture.em,
    );
  });

  it.each(['archive', 'manual'] as const)(
    'opens a stretch of its own for a %s close when none is queued',
    async (closer) => {
      const fixture = build();

      await fixture.service.start('src', {}, closer);

      expect(fixture.segments.create).toHaveBeenCalledWith(
        expect.objectContaining({
          closedBy: closer,
          attempts: 1,
          status: 'reflecting',
          leaseUntil: expect.any(Date),
        }),
        fixture.em,
      );
    },
  );
});

describe('LessonReflectionService: a reflection that ends without filing', () => {
  const reflecting = (attempts: number) => ({
    id: 'seg-9',
    runId: 'src',
    status: 'reflecting',
    attempts,
  });

  it('puts its stretch back in the queue with the reason when its terminal status arrives while the stretch is still reflecting', async () => {
    const fixture = build({ reflectionSegment: reflecting(1) });
    fixture.service.onModuleInit();

    fixture.statuses.next({ runId: 'refl-9', status: 'completed' });

    await vi.waitFor(() =>
      expect(fixture.segments.updateById).toHaveBeenCalledWith(
        'seg-9',
        {
          status: 'queued',
          failReason: 'the reflection ended without filing lessons',
          leaseUntil: null,
        },
        fixture.em,
      ),
    );
    fixture.service.onModuleDestroy();
  });

  it('records the reflection’s own error as the reason', async () => {
    const fixture = build({
      reflectionSegment: reflecting(1),
      runItems: [
        {
          seq: 1,
          kind: 'error',
          role: null,
          payload: JSON.stringify({ message: 'rate limited' }),
        },
      ],
    });
    fixture.service.onModuleInit();

    fixture.statuses.next({ runId: 'refl-9', status: 'failed' });

    await vi.waitFor(() =>
      expect(fixture.segments.updateById).toHaveBeenCalledWith(
        'seg-9',
        expect.objectContaining({ failReason: 'rate limited' }),
        fixture.em,
      ),
    );
    fixture.service.onModuleDestroy();
  });

  it('leaves the stretch failed once its attempts are spent', async () => {
    const fixture = build({ reflectionSegment: reflecting(3) });
    fixture.service.onModuleInit();

    fixture.statuses.next({ runId: 'refl-9', status: 'completed' });

    await vi.waitFor(() =>
      expect(fixture.segments.updateById).toHaveBeenCalledWith(
        'seg-9',
        expect.objectContaining({ status: 'failed' }),
        fixture.em,
      ),
    );
    fixture.service.onModuleDestroy();
  });

  it('announces the stretch on its thread', async () => {
    const fixture = build({ reflectionSegment: reflecting(1) });
    const announced: (string | null)[] = [];
    fixture.events
      .allChanges()
      .subscribe((event) => announced.push(event.runId));
    fixture.service.onModuleInit();

    fixture.statuses.next({ runId: 'refl-9', status: 'completed' });

    await vi.waitFor(() => expect(announced).toEqual(['src']));
    fixture.service.onModuleDestroy();
  });

  it.each(['reflected', 'checking', 'empty', 'failed', 'queued'])(
    'leaves a stretch that is already %s alone',
    async (status) => {
      const fixture = build({
        reflectionSegment: { ...reflecting(1), status },
      });
      fixture.service.onModuleInit();

      fixture.statuses.next({ runId: 'refl-9', status: 'completed' });
      await vi.waitFor(() =>
        expect(fixture.segments.ofReflection).toHaveBeenCalledWith(
          'refl-9',
          fixture.em,
        ),
      );

      expect(fixture.segments.updateById).not.toHaveBeenCalled();
      fixture.service.onModuleDestroy();
    },
  );

  it('leaves a reflection still running alone', async () => {
    const fixture = build({ reflectionSegment: reflecting(1) });
    fixture.service.onModuleInit();

    fixture.statuses.next({ runId: 'refl-9', status: 'running' });

    expect(fixture.segments.ofReflection).not.toHaveBeenCalled();
    expect(fixture.segments.updateById).not.toHaveBeenCalled();
    fixture.service.onModuleDestroy();
  });
});

describe('LessonReflectionService.abandon', () => {
  const stretch = (overrides: Record<string, unknown>) =>
    ({
      id: 'seg-9',
      runId: 'src',
      status: 'reflecting',
      attempts: 1,
      reflectionRunId: 'refl-9',
      ...overrides,
    }) as never;

  it('cancels the reflection and queues the stretch again with the limit as the reason', async () => {
    const fixture = build();

    await fixture.service.abandon(stretch({}));

    expect(fixture.chats.cancel).toHaveBeenCalledWith('refl-9');
    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-9',
      {
        status: 'queued',
        failReason: 'the reflection ran past its 30-minute limit',
        leaseUntil: null,
      },
      fixture.em,
    );
  });

  it('fails the stretch for good on its last attempt, with no chat to cancel when it never started one', async () => {
    const fixture = build();

    await fixture.service.abandon(
      stretch({ attempts: 3, reflectionRunId: null }),
    );

    expect(fixture.chats.cancel).not.toHaveBeenCalled();
    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-9',
      expect.objectContaining({ status: 'failed' }),
      fixture.em,
    );
  });
});

describe('LessonReflectionService.runningReflectionId', () => {
  it('names the reflection still working on the thread', async () => {
    const fixture = build({
      running: [{ id: 'r1', status: 'running' }],
    });

    await expect(fixture.service.runningReflectionId('src')).resolves.toBe(
      'r1',
    );
  });

  it('answers null once every reflection on the thread has finished', async () => {
    const fixture = build({
      running: [{ id: 'r0', status: 'completed' }],
    });

    await expect(
      fixture.service.runningReflectionId('src'),
    ).resolves.toBeNull();
  });
});

describe('LessonReflectionService.start on a thread being deleted', () => {
  const DELETING = { pendingDeleteAt: new Date() };

  it('refuses a reflection on it unless it is the delete that asked for one', async () => {
    const fixture = build({ source: DELETING });

    await expect(fixture.service.start('src', {})).rejects.toMatchObject({
      errorCode: 'LESSONS_NOT_REFLECTABLE',
    });
    expect(fixture.chats.createChat).not.toHaveBeenCalled();
  });

  it('starts the reflection of a delete that extracts lessons first', async () => {
    const fixture = build({ source: DELETING });

    const started = await fixture.service.start('src', {}, 'delete');

    expect(started.reflectionRunId).toBe('refl-run');
    expect(fixture.segments.create).toHaveBeenCalledWith(
      expect.objectContaining({ closedBy: 'delete', status: 'reflecting' }),
      fixture.em,
    );
  });
});
