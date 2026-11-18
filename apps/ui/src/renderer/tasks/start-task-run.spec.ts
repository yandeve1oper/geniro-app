import { describe, expect, it, vi } from 'vitest';

import type { TaskWorktreeResult } from '../../shared/contracts';
import type { DaemonApis } from '../daemon-api';
import { aProject, aTask } from './__tests__/fixtures';
import {
  mayGiveBackWorktree,
  startTaskRun,
  type TaskRunBridge,
} from './start-task-run';

const READY: TaskWorktreeResult = {
  ok: true,
  path: '/worktrees/t1',
  branch: 'geniro/task-t1',
  reused: false,
  error: null,
};

function stubBridge(made: TaskWorktreeResult = READY) {
  const prepareTaskWorktree = vi.fn().mockResolvedValue(made);
  const getGitStamp = vi
    .fn()
    .mockResolvedValue({ sha: 'abc123', dirty: false });
  const pruneTaskWorktree = vi.fn().mockResolvedValue(true);
  return {
    bridge: {
      prepareTaskWorktree,
      getGitStamp,
      pruneTaskWorktree,
    } as unknown as TaskRunBridge,
    prepareTaskWorktree,
    getGitStamp,
    pruneTaskWorktree,
  };
}

function stubTasks(
  startTaskRun: ReturnType<typeof vi.fn>,
  readTask: ReturnType<typeof vi.fn> = vi.fn(),
): Pick<DaemonApis, 'tasks'> {
  return { tasks: { startTaskRun, readTask } } as unknown as Pick<
    DaemonApis,
    'tasks'
  >;
}

/** A refusal in the daemon's uniform shape, as `createDaemonApis` throws it. */
function refusal(status: number, code: string, message: string): Error {
  return new Error(
    `daemon POST /v1/tasks/t1/runs failed (${status}): ${JSON.stringify({
      statusCode: status,
      code,
      message,
    })}`,
  );
}

const readRunSettings = () => Promise.resolve({ replyLanguage: 'Russian' });

describe('startTaskRun', () => {
  it('makes the worktree, then posts the run with the git stamp and the run settings', async () => {
    const { bridge, prepareTaskWorktree, pruneTaskWorktree } = stubBridge();
    const started = aTask({ id: 't1', status: 'in_progress' });
    const startTaskRunApi = vi.fn().mockResolvedValue(started);
    const task = aTask({ id: 't1', status: 'todo', folder: null });

    const result = await startTaskRun({
      apis: stubTasks(startTaskRunApi),
      bridge,
      readRunSettings,
      task,
      project: aProject({ id: 'p1', folder: '/repo' }),
    });

    expect(prepareTaskWorktree).toHaveBeenCalledWith({
      taskId: 't1',
      folder: '/repo',
    });
    expect(startTaskRunApi).toHaveBeenCalledWith({
      taskId: 't1',
      startTaskRunDto: {
        cwd: '/worktrees/t1',
        branch: 'geniro/task-t1',
        from: 'todo',
        startSha: 'abc123',
        startDirty: false,
        replyLanguage: 'Russian',
      },
    });
    expect(result).toBe(started);
    expect(pruneTaskWorktree).not.toHaveBeenCalled();
  });

  it('prefers the card folder over the project folder', async () => {
    const { bridge, prepareTaskWorktree } = stubBridge();

    await startTaskRun({
      apis: stubTasks(vi.fn().mockResolvedValue(aTask())),
      bridge,
      readRunSettings,
      task: aTask({ id: 't1', folder: '/card' }),
      project: aProject({ folder: '/repo' }),
    });

    expect(prepareTaskWorktree).toHaveBeenCalledWith({
      taskId: 't1',
      folder: '/card',
    });
  });

  it('sends the trimmed prompt and the given startedBy', async () => {
    const { bridge } = stubBridge();
    const startTaskRunApi = vi.fn().mockResolvedValue(aTask());

    await startTaskRun({
      apis: stubTasks(startTaskRunApi),
      bridge,
      readRunSettings,
      task: aTask({ id: 't1' }),
      project: aProject(),
      prompt: '  write the brief  ',
      startedBy: 'user',
    });

    expect(startTaskRunApi).toHaveBeenCalledWith(
      expect.objectContaining({
        startTaskRunDto: expect.objectContaining({
          prompt: 'write the brief',
          startedBy: 'user',
        }),
      }),
    );
  });

  it('gives back a worktree it made when the daemon refuses the start', async () => {
    const { bridge, pruneTaskWorktree } = stubBridge();
    const refused = refusal(400, 'NO_RUN_TARGET', 'no agent or team');
    const readTask = vi.fn().mockResolvedValue(aTask({ status: 'todo' }));

    await expect(
      startTaskRun({
        apis: stubTasks(vi.fn().mockRejectedValue(refused), readTask),
        bridge,
        readRunSettings,
        task: aTask({ id: 't1', status: 'todo' }),
        project: aProject(),
      }),
    ).rejects.toBe(refused);

    expect(pruneTaskWorktree).toHaveBeenCalledWith('t1');
  });

  it('keeps a worktree the task already had standing when the start is refused', async () => {
    const { bridge, pruneTaskWorktree } = stubBridge({
      ...READY,
      reused: true,
    });

    await expect(
      startTaskRun({
        apis: stubTasks(
          vi.fn().mockRejectedValue(refusal(400, 'NO_RUN_TARGET', 'no agent')),
          vi.fn().mockResolvedValue(aTask({ status: 'todo' })),
        ),
        bridge,
        readRunSettings,
        task: aTask({ id: 't1', status: 'todo' }),
        project: aProject(),
      }),
    ).rejects.toThrow('no agent');

    expect(pruneTaskWorktree).not.toHaveBeenCalled();
  });

  it('throws the worktree’s own failure without posting anything', async () => {
    const { bridge, getGitStamp, pruneTaskWorktree } = stubBridge({
      ok: false,
      path: null,
      branch: null,
      reused: false,
      error: 'fatal: not a git repository',
    });
    const startTaskRunApi = vi.fn();

    await expect(
      startTaskRun({
        apis: stubTasks(startTaskRunApi),
        bridge,
        readRunSettings,
        task: aTask({ id: 't1' }),
        project: aProject(),
      }),
    ).rejects.toThrow('fatal: not a git repository');

    expect(getGitStamp).not.toHaveBeenCalled();
    expect(startTaskRunApi).not.toHaveBeenCalled();
    expect(pruneTaskWorktree).not.toHaveBeenCalled();
  });
});

describe('mayGiveBackWorktree', () => {
  it('keeps the worktree, without reading the card, when the refusal names another start of it', async () => {
    const readTask = vi.fn();

    await expect(
      mayGiveBackWorktree(
        stubTasks(vi.fn(), readTask),
        't1',
        refusal(409, 'TASK_RUN_STARTING', 'task t1 is already starting a run'),
      ),
    ).resolves.toBe(false);

    expect(readTask).not.toHaveBeenCalled();
  });

  it('keeps the worktree while the card is being worked', async () => {
    await expect(
      mayGiveBackWorktree(
        stubTasks(
          vi.fn(),
          vi.fn().mockResolvedValue(aTask({ status: 'in_progress' })),
        ),
        't1',
        refusal(400, 'TASK_STATUS_CONFLICT', 'task t1 is in in_progress'),
      ),
    ).resolves.toBe(false);
  });

  it('gives the worktree back when the card is gone', async () => {
    await expect(
      mayGiveBackWorktree(
        stubTasks(
          vi.fn(),
          vi
            .fn()
            .mockRejectedValue(
              new Error('daemon GET /v1/tasks/t1 failed (404): gone'),
            ),
        ),
        't1',
        refusal(400, 'TASK_STATUS_CONFLICT', 'task t1 moved'),
      ),
    ).resolves.toBe(true);
  });
});
