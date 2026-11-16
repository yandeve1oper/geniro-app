import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../environments';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import type { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ChatService } from '../../agents/services/chat.service';
import type { MemoryService } from '../../memory/services/memory.service';
import type { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { Run } from '../../runs/entity/run.entity';
import type { LessonProposalDao } from '../dao/lesson-proposal.dao';
import type { LessonSegmentDao } from '../dao/lesson-segment.dao';
import { DEFAULT_LESSONS_CONFIG, type LessonsConfig } from '../lessons.types';
import { LessonReflectionService } from './lesson-reflection.service';
import { LessonsConfigService } from './lessons-config.service';

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
    ...overrides,
  } as unknown as Run;
}

function build(
  options: {
    source?: Partial<Run>;
    maxSeq?: number;
    /** The newest row that is not a lessons row; defaults to `maxSeq`. */
    newestOwn?: number;
    items?: Item[];
    running?: Partial<Run>[];
    project?: { id: string; folder: string } | null;
    config?: LessonsConfig;
    rejected?: { title: string; rejectReason: string | null }[];
    sendFails?: Error;
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
      Promise.resolve({ id: 'refl-run' }),
    ),
    sendMessage: vi.fn((_runId: string, _brief: string) =>
      options.sendFails === undefined
        ? Promise.resolve({})
        : Promise.reject(options.sendFails),
    ),
    delete: vi.fn((_runId: string) => Promise.resolve({ deleted: true })),
  };
  const segments = {
    create: vi.fn((input: Record<string, unknown>) =>
      Promise.resolve({ id: 'seg-1', ...input }),
    ),
    updateById: vi.fn(() => Promise.resolve()),
    deleteOfRuns: vi.fn((_runIds: readonly string[], _em: unknown) =>
      Promise.resolve(),
    ),
  };
  const deleted = new Subject<string>();
  const proposals = {
    rejectedIn: vi.fn(() => Promise.resolve(options.rejected ?? [])),
  };
  const projectScope = {
    projectOfRun: vi.fn(() => Promise.resolve(options.project ?? null)),
  };
  const config = new LessonsConfigService();
  config.set(options.config ?? DEFAULT_LESSONS_CONFIG);
  const service = new LessonReflectionService(
    em,
    runDao as unknown as RunDao,
    itemDao as unknown as ItemDao,
    chats as unknown as ChatService,
    { allDeleted: () => deleted.asObservable() } as unknown as AgentEventBus,
    { enabled: true } as MemoryService,
    projectScope as unknown as ProjectScopeService,
    segments as unknown as LessonSegmentDao,
    proposals as unknown as LessonProposalDao,
    config,
  );
  return {
    service,
    em,
    runDao,
    itemDao,
    chats,
    segments,
    proposals,
    projectScope,
    deleted,
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

  it('takes the agent, model and effort the input names over the settings', async () => {
    const fixture = build({
      config: {
        mode: 'offer',
        agentKind: 'claude',
        model: 'haiku',
        effort: 'low',
      },
    });

    await fixture.service.start('src', {
      agentKind: 'codex',
      model: 'gpt-5',
      effort: 'high',
    });

    expect(fixture.chats.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'codex',
        model: 'gpt-5',
        effort: 'high',
      }),
    );
  });

  it('takes the model and effort from the settings when they name no agent', async () => {
    const fixture = build({
      config: { mode: 'offer', agentKind: null, model: 'haiku', effort: 'low' },
    });

    await fixture.service.start('src', {});

    expect(fixture.chats.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'claude',
        model: 'haiku',
        effort: 'low',
      }),
    );
  });

  it('drops the settings’ model and effort when the input switches to another agent', async () => {
    const fixture = build({
      config: {
        mode: 'offer',
        agentKind: 'codex',
        model: 'o3',
        effort: 'high',
      },
    });

    await fixture.service.start('src', { agentKind: 'claude' });

    const input = fixture.chats.createChat.mock.calls[0]![0];
    expect(input).toMatchObject({ agentKind: 'claude' });
    expect(input.model).toBeUndefined();
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

  it('deletes the new chat and marks its segment failed when the brief cannot be sent', async () => {
    const fixture = build({ sendFails: new Error('boom') });

    await expect(fixture.service.start('src', {})).rejects.toThrow('boom');

    expect(fixture.chats.delete).toHaveBeenCalledWith('refl-run');
    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-1',
      { status: 'failed' },
      fixture.em,
    );
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

  it('falls back to the thread’s own agent when the settings name an agent this app does not know', async () => {
    const fixture = build({
      source: { agentKind: 'claude' },
      config: {
        mode: 'offer',
        agentKind: 'mystery-cli' as never,
        model: 'haiku',
        effort: 'low',
      },
    });

    await fixture.service.start('src', {});

    const input = fixture.chats.createChat.mock.calls[0]![0];
    expect(input).toMatchObject({ agentKind: 'claude' });
    expect(input.model).toBeUndefined();
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
});
