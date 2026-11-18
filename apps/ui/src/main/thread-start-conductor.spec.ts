import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle, GitStamp } from '../shared/contracts';
import {
  ThreadStartConductor,
  type ThreadStartDeps,
} from './thread-start-conductor';

const handle: DaemonHandle = {
  host: '127.0.0.1',
  port: 47615,
  token: 'tok',
  version: '0.1.0',
  startedAt: '2026-09-07T12:00:00.000Z',
};

const START_SHA = 'b'.repeat(40);

interface ApprovedRow {
  taskId: string;
  projectId: string;
  title: string;
  status: string;
  folder: string;
}

function row(taskId: string, over: Partial<ApprovedRow> = {}): ApprovedRow {
  return {
    taskId,
    projectId: 'p1',
    title: `card ${taskId}`,
    status: 'todo',
    folder: '/repo',
    ...over,
  };
}

function reply(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  } as Response;
}

/**
 * A stand-in daemon for the three routes a drain uses: the approved list, the
 * run start, and the failure report. `approved` is the daemon's own queue: a
 * start the daemon takes leaves it, as the route clears the request.
 */
function daemon(approved: ApprovedRow[]) {
  const starts: { path: string; body: Record<string, unknown> }[] = [];
  const failures: { taskId: string; reason: unknown }[] = [];
  const refuseWith = new Map<string, { status: number; body: string }>();
  const cards = new Map<string, string>();
  const fetchMock = vi.fn(
    async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const target = new URL(String(url));
      const path = target.pathname;
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const failed = /^\/v1\/command-center\/starts\/([^/]+)\/failed$/.exec(
          path,
        );
        if (failed?.[1] !== undefined) {
          failures.push({ taskId: failed[1], reason: body.reason });
          return reply(204);
        }
        const refusal = refuseWith.get(path);
        if (refusal !== undefined) {
          return reply(refusal.status, refusal.body);
        }
        const run = /^\/v1\/tasks\/([^/]+)\/runs$/.exec(path);
        if (run?.[1] !== undefined) {
          starts.push({ path, body });
          const index = approved.findIndex((r) => r.taskId === run[1]);
          approved.splice(index, 1);
          return reply(201, '{}');
        }
        return reply(404);
      }
      if (
        path === '/v1/command-center/starts' &&
        target.searchParams.get('state') === 'approved'
      ) {
        return reply(200, JSON.stringify({ starts: approved }));
      }
      const cardId = /^\/v1\/tasks\/([^/]+)$/.exec(path)?.[1];
      if (cardId !== undefined) {
        const status = cards.get(cardId);
        return status === undefined
          ? reply(404)
          : reply(200, JSON.stringify({ id: cardId, status }));
      }
      return reply(404);
    },
  );
  return { fetchMock, starts, failures, refuseWith, cards };
}

function deps(over: Partial<ThreadStartDeps> = {}): ThreadStartDeps {
  return {
    handle: () => handle,
    prepareWorktree: vi.fn(async ({ taskId }: { taskId: string }) => ({
      path: `/wt/${taskId}`,
      branch: `geniro/${taskId}`,
      reused: false,
    })),
    discardWorktree: vi.fn(async () => true),
    gitStamp: vi.fn(async (): Promise<GitStamp> => ({
      sha: START_SHA,
      dirty: false,
    })),
    agentOptions: () => ({ claude: { browserTools: true } }),
    customInstructions: () => '',
    replyLanguage: () => '',
    holdDaemon: vi.fn(),
    log: vi.fn(),
    intervalMs: 5,
    ...over,
  };
}

describe('ThreadStartConductor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // The start is the user's own: it names the manager as the starter and
  // carries no approval, so the user's or the project's default applies. An
  // autopilot approval here would be the forced `auto` this drain must never
  // send.
  it('starts an approved thread once, as the manager’s, on the default approval', async () => {
    const { fetchMock, starts } = daemon([
      row('t1', { title: 'Write the spec' }),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const d = deps();

    await new ThreadStartConductor(d).tick();

    expect(d.prepareWorktree).toHaveBeenCalledWith({
      taskId: 't1',
      folder: '/repo',
    });
    expect(starts).toHaveLength(1);
    expect(starts[0]?.path).toBe('/v1/tasks/t1/runs');
    expect(starts[0]?.body).toMatchObject({
      cwd: '/wt/t1',
      branch: 'geniro/t1',
      from: 'todo',
      startedBy: 'manager',
      startSha: START_SHA,
      startDirty: false,
      agentOptions: { claude: { browserTools: true } },
    });
    expect(starts[0]?.body).not.toHaveProperty('approval');
  });

  it('does not start a thread again while the tick that started it is still in flight', async () => {
    const { fetchMock, starts } = daemon([row('t1')]);
    vi.stubGlobal('fetch', fetchMock);
    const conductor = new ThreadStartConductor(deps());

    await Promise.all([conductor.tick(), conductor.tick()]);

    expect(starts).toHaveLength(1);
  });

  it('does not post a start the daemon has already taken on a later tick', async () => {
    const { fetchMock, starts } = daemon([row('t1')]);
    vi.stubGlobal('fetch', fetchMock);
    const conductor = new ThreadStartConductor(deps());

    await conductor.tick();
    await conductor.tick();

    expect(starts).toHaveLength(1);
  });

  it('reads the approved list every five seconds while it runs, and stops with stop()', async () => {
    const { fetchMock } = daemon([]);
    vi.stubGlobal('fetch', fetchMock);
    const conductor = new ThreadStartConductor(deps({ intervalMs: undefined }));

    conductor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    conductor.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The worktree is a prepare failure's, so the daemon is told the card could
  // not be started and clears the request, instead of the manager waiting on a
  // start that will never come.
  it('reports a worktree it cannot prepare to the failed route, and starts nothing', async () => {
    const { fetchMock, starts, failures } = daemon([row('t1')]);
    vi.stubGlobal('fetch', fetchMock);
    const d = deps({
      prepareWorktree: vi.fn(async () => {
        throw new Error('fatal: not a git repository');
      }),
    });

    await new ThreadStartConductor(d).tick();

    expect(starts).toHaveLength(0);
    expect(failures).toEqual([
      { taskId: 't1', reason: 'fatal: not a git repository' },
    ]);
    expect(d.discardWorktree).not.toHaveBeenCalled();
  });

  it('reports a start the daemon refuses for good, and gives back the worktree it made', async () => {
    const { fetchMock, failures, refuseWith } = daemon([row('t1')]);
    refuseWith.set('/v1/tasks/t1/runs', {
      status: 400,
      body: JSON.stringify({
        code: 'NO_AGENT',
        description: 'No agent is configured for this card',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const d = deps();

    await new ThreadStartConductor(d).tick();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.taskId).toBe('t1');
    expect(String(failures[0]?.reason)).toContain(
      'No agent is configured for this card',
    );
    expect(d.discardWorktree).toHaveBeenCalledWith('t1');
  });

  // A 409 means another start of the card holds it. It is not a failure, so the
  // daemon is not told one, and the request stays for the next tick.
  it('leaves a 409 refusal alone: no failure reported, the request kept for a later tick', async () => {
    const { fetchMock, failures, refuseWith } = daemon([row('t1')]);
    refuseWith.set('/v1/tasks/t1/runs', {
      status: 409,
      body: JSON.stringify({
        code: 'TASK_RUN_STARTING',
        description: 'A start of this card is already in flight',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const d = deps();

    await new ThreadStartConductor(d).tick();

    expect(failures).toHaveLength(0);
    expect(d.discardWorktree).not.toHaveBeenCalled();
    expect(d.holdDaemon).toHaveBeenLastCalledWith(true);
  });

  it('keeps a reused worktree when a start is refused for good', async () => {
    const { fetchMock, failures, refuseWith } = daemon([row('t1')]);
    refuseWith.set('/v1/tasks/t1/runs', {
      status: 400,
      body: JSON.stringify({ code: 'BAD', description: 'refused' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const d = deps({
      prepareWorktree: vi.fn(async () => ({
        path: '/wt/t1',
        branch: 'geniro/t1',
        reused: true,
      })),
    });

    await new ThreadStartConductor(d).tick();

    expect(failures).toHaveLength(1);
    expect(d.discardWorktree).not.toHaveBeenCalled();
  });

  // The keep-alive is held while a start waits and released once none does,
  // so a daemon with nothing to start is free to idle out.
  it('holds the daemon while an approved start waits, and releases it after', async () => {
    const { fetchMock } = daemon([row('t1')]);
    vi.stubGlobal('fetch', fetchMock);
    const d = deps();
    const conductor = new ThreadStartConductor(d);

    await conductor.tick();
    await conductor.tick();

    expect(d.holdDaemon).toHaveBeenNthCalledWith(1, true);
    expect(d.holdDaemon).toHaveBeenLastCalledWith(false);
    expect(d.holdDaemon).toHaveBeenCalledTimes(2);
  });

  it('skips a tick silently while the daemon is unreachable, and says so once', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);
    const d = deps();
    const conductor = new ThreadStartConductor(d);

    await conductor.tick();
    await conductor.tick();
    await conductor.tick();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(d.log).toHaveBeenCalledTimes(1);
    expect(d.holdDaemon).not.toHaveBeenCalled();
  });

  it('does nothing while no daemon is running', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await new ThreadStartConductor(deps({ handle: () => null })).tick();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts nothing for a start that names no folder, and logs it once', async () => {
    const { fetchMock, starts, failures } = daemon([row('t1', { folder: '' })]);
    vi.stubGlobal('fetch', fetchMock);
    const d = deps();
    const conductor = new ThreadStartConductor(d);

    await conductor.tick();
    await conductor.tick();

    expect(starts).toHaveLength(0);
    expect(failures).toHaveLength(0);
    expect(d.prepareWorktree).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledTimes(1);
  });
});
