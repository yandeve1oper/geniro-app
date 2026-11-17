// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPreloadStub } from '../__fixtures__/preload-stub';
import type { DaemonApis } from '../daemon-api';
import {
  isMissingCwdError,
  restoreRunWorktree,
  sendRestoringWorktree,
  type WorktreeRun,
} from './task-worktree';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A refusal in the daemon's uniform shape, as `createDaemonApis` throws it. */
const refusal = (status: number, code: string, message: string): Error =>
  new Error(
    `daemon POST /v1/chats/r1/messages failed (${status}): ${JSON.stringify({
      code,
      message,
    })}`,
  );

const missingCwd = (): Error =>
  refusal(400, 'INVALID_CWD', 'cwd does not exist: /userData/worktrees/t1');

const taskChat: WorktreeRun = { taskId: 't1', cwd: '/userData/worktrees/t1' };
const analysisChat: WorktreeRun = {
  taskId: null,
  cwd: '/userData/worktrees/t1',
};

function fakeApis(
  cardFolder: string | null,
  worktreePath: string | null = '/userData/worktrees/t1',
): {
  apis: Pick<DaemonApis, 'tasks' | 'projects'>;
  readTask: ReturnType<typeof vi.fn>;
  readProject: ReturnType<typeof vi.fn>;
} {
  const readTask = vi.fn(async () => ({
    id: 't1',
    projectId: 'p1',
    folder: cardFolder,
    worktreePath,
  }));
  const readProject = vi.fn(async () => ({ id: 'p1', folder: '/repo' }));
  return {
    apis: {
      tasks: { readTask },
      projects: { readProject },
    } as unknown as Pick<DaemonApis, 'tasks' | 'projects'>,
    readTask,
    readProject,
  };
}

function stubPrepare(ok: boolean): ReturnType<typeof vi.fn> {
  const prepareTaskWorktree = vi.fn(async () => ({
    ok,
    path: ok ? '/userData/worktrees/t1' : null,
    branch: ok ? 'geniro/task-t1' : null,
    reused: false,
    error: ok ? null : 'fatal: not a git repository',
  }));
  window.geniro = createPreloadStub({ prepareTaskWorktree });
  return prepareTaskWorktree;
}

describe('isMissingCwdError', () => {
  it('reads the daemon’s code, not its sentence', () => {
    expect(isMissingCwdError(missingCwd())).toBe(true);
    // A different refusal whose MESSAGE happens to say the same words.
    expect(
      isMissingCwdError(
        refusal(400, 'INVALID_CONFIG_DIR', 'cwd does not exist'),
      ),
    ).toBe(false);
  });
});

describe('sendRestoringWorktree', () => {
  it('puts a task’s worktree back and sends once more when its folder is gone', async () => {
    const send = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(missingCwd())
      .mockResolvedValueOnce('sent');
    const restore = vi.fn(async () => true);

    await expect(sendRestoringWorktree(send, taskChat, restore)).resolves.toBe(
      'sent',
    );
    expect(restore).toHaveBeenCalledWith(taskChat);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('shows the daemon’s own refusal when the worktree could not be restored', async () => {
    const original = missingCwd();
    const send = vi.fn<() => Promise<string>>().mockRejectedValue(original);

    await expect(
      sendRestoringWorktree(send, taskChat, async () => false),
    ).rejects.toBe(original);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('never restores anything when the send names no run', async () => {
    const original = missingCwd();
    const send = vi.fn<() => Promise<string>>().mockRejectedValue(original);
    const restore = vi.fn(async () => true);

    await expect(sendRestoringWorktree(send, null, restore)).rejects.toBe(
      original,
    );
    expect(restore).not.toHaveBeenCalled();
  });

  it('leaves every other refusal alone', async () => {
    const busy = refusal(409, 'RUN_BUSY', 'a turn is already running');
    const send = vi.fn<() => Promise<string>>().mockRejectedValue(busy);
    const restore = vi.fn(async () => true);
    const onRestoring = vi.fn();

    await expect(
      sendRestoringWorktree(send, taskChat, restore, onRestoring),
    ).rejects.toBe(busy);
    expect(restore).not.toHaveBeenCalled();
    expect(onRestoring).not.toHaveBeenCalled();
  });

  it('says the send is held before the restore starts', async () => {
    const send = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(missingCwd())
      .mockResolvedValueOnce('sent');
    const onRestoring = vi.fn();
    const restore = vi.fn(async () => {
      expect(onRestoring).toHaveBeenCalledTimes(1);
      return true;
    });

    await expect(
      sendRestoringWorktree(send, taskChat, restore, onRestoring),
    ).resolves.toBe('sent');
    expect(restore).toHaveBeenCalledTimes(1);
    expect(onRestoring).toHaveBeenCalledTimes(1);
  });

  it('says nothing is held when the first send goes through', async () => {
    const onRestoring = vi.fn();

    await expect(
      sendRestoringWorktree(
        async () => 'sent',
        taskChat,
        async () => true,
        onRestoring,
      ),
    ).resolves.toBe('sent');
    expect(onRestoring).not.toHaveBeenCalled();
  });

  it('sends only ONCE more, and shows a second refusal as it is', async () => {
    const second = missingCwd();
    const send = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(missingCwd())
      .mockRejectedValueOnce(second);

    await expect(
      sendRestoringWorktree(send, taskChat, async () => true),
    ).rejects.toBe(second);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('restoreRunWorktree', () => {
  it('cuts it from the card’s own folder when the card names one', async () => {
    const prepare = stubPrepare(true);
    const { apis, readProject } = fakeApis('/elsewhere');

    await expect(restoreRunWorktree(apis, taskChat)).resolves.toBe(true);
    expect(prepare).toHaveBeenCalledWith({
      taskId: 't1',
      folder: '/elsewhere',
    });
    expect(readProject).not.toHaveBeenCalled();
  });

  it('falls back to the project’s folder, as a Run press does', async () => {
    const prepare = stubPrepare(true);
    const { apis } = fakeApis(null);

    await expect(restoreRunWorktree(apis, taskChat)).resolves.toBe(true);
    expect(prepare).toHaveBeenCalledWith({ taskId: 't1', folder: '/repo' });
  });

  it('answers false when main could not make the worktree', async () => {
    stubPrepare(false);
    const { apis } = fakeApis(null);

    await expect(restoreRunWorktree(apis, taskChat)).resolves.toBe(false);
  });

  it('puts back the card’s worktree for a chat that works in it without being the card’s own', async () => {
    const prepare = stubPrepare(true);
    const { apis, readTask } = fakeApis(null);

    await expect(restoreRunWorktree(apis, analysisChat)).resolves.toBe(true);
    expect(readTask).toHaveBeenCalledWith({ taskId: 't1' });
    expect(prepare).toHaveBeenCalledWith({ taskId: 't1', folder: '/repo' });
  });

  it('restores nothing for a chat whose folder the card does not record as its worktree', async () => {
    const prepare = stubPrepare(true);
    const { apis } = fakeApis(null, '/userData/worktrees/t1');

    await expect(
      restoreRunWorktree(apis, { taskId: null, cwd: '/projects/t1' }),
    ).resolves.toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('restores nothing for a chat with no folder and no card', async () => {
    const prepare = stubPrepare(true);
    const { apis, readTask } = fakeApis(null);

    await expect(
      restoreRunWorktree(apis, { taskId: null, cwd: null }),
    ).resolves.toBe(false);
    expect(readTask).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('answers false when the card cannot be read, rather than throwing', async () => {
    const prepare = stubPrepare(true);
    const { apis, readTask } = fakeApis(null);
    readTask.mockRejectedValue(
      new Error('daemon GET /v1/tasks/t1 failed (404)'),
    );

    await expect(restoreRunWorktree(apis, taskChat)).resolves.toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });
});
