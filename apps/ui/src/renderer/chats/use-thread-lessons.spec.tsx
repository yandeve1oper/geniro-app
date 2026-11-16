// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonApis } from '../daemon-api';
import type { DaemonClient, RunStatusEvent } from '../daemon-client';
import {
  LESSONS_POLL_MS,
  type ThreadLessonsMark,
  useThreadLessons,
} from './use-thread-lessons';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  vi.useRealTimers();
});

type State = {
  reflectable: boolean;
  reflectionRunId: string | null;
  reflectedThroughSeq: number | null;
};

const READY: State = {
  reflectable: true,
  reflectionRunId: null,
  reflectedThroughSeq: null,
};
const REFLECTING: State = {
  reflectable: false,
  reflectionRunId: 'refl-1',
  reflectedThroughSeq: null,
};
const NOTHING_NEW: State = {
  reflectable: false,
  reflectionRunId: null,
  reflectedThroughSeq: 9,
};

function harness(
  answers: (() => Promise<State>)[] | null,
  options: { api?: boolean } = {},
) {
  const getThreadLessonsState = vi.fn(
    answers === null
      ? () => Promise.resolve(READY)
      : () => {
          const next = answers.shift();
          return next === undefined ? Promise.resolve(NOTHING_NEW) : next();
        },
  );
  const lessonsApi =
    options.api === false
      ? null
      : ({ getThreadLessonsState } as unknown as DaemonApis['lessons']);
  const listeners = new Set<(event: RunStatusEvent) => void>();
  const client = {
    onRunStatus: (listener: (event: RunStatusEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as DaemonClient;
  let mark: ThreadLessonsMark = 'unknown';
  function Probe({
    source,
    refreshKey,
  }: {
    source: string | null;
    refreshKey: number;
  }): null {
    mark = useThreadLessons({
      lessonsApi,
      client,
      sourceRunId: source,
      refreshKey,
    });
    return null;
  }
  const container = document.createElement('div');
  root = createRoot(container);
  return {
    getThreadLessonsState,
    mark: () => mark,
    render: async (source: string | null, refreshKey = 0) => {
      await act(async () => {
        root!.render(<Probe source={source} refreshKey={refreshKey} />);
      });
    },
    status: async (runId: string, status: RunStatusEvent['status']) => {
      await act(async () => {
        for (const listener of listeners) {
          listener({ runId, status } as RunStatusEvent);
        }
      });
    },
    elapse: async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    },
  };
}

describe('useThreadLessons', () => {
  it('maps the daemon’s state to ready, reflecting or nothing new', async () => {
    const h = harness([
      () => Promise.resolve(READY),
      () => Promise.resolve(REFLECTING),
      () => Promise.resolve(NOTHING_NEW),
    ]);

    await h.render('source');
    expect(h.mark()).toBe('ready');

    await h.render('source', 1);
    expect(h.mark()).toBe('reflecting');

    await h.render('source', 2);
    expect(h.mark()).toBe('nothing_new');
  });

  it('reads nothing and marks unknown without a lessons API or a thread', async () => {
    const detached = harness(null, { api: false });
    await detached.render('source');
    expect(detached.mark()).toBe('unknown');

    const none = harness(null);
    await none.render(null);
    expect(none.getThreadLessonsState).not.toHaveBeenCalled();
    expect(none.mark()).toBe('unknown');
  });

  it('marks unknown when the state cannot be read', async () => {
    const h = harness([() => Promise.reject(new Error('daemon down'))]);

    await h.render('source');

    expect(h.mark()).toBe('unknown');
  });

  it('asks again every poll interval while a reflection works, and stops once it has filed', async () => {
    const h = harness([
      () => Promise.resolve(REFLECTING),
      () => Promise.resolve(REFLECTING),
      () => Promise.resolve(READY),
    ]);

    await h.render('source');
    expect(h.mark()).toBe('reflecting');
    expect(h.getThreadLessonsState).toHaveBeenCalledTimes(1);

    await h.elapse(LESSONS_POLL_MS - 1);
    expect(h.getThreadLessonsState).toHaveBeenCalledTimes(1);

    await h.elapse(1);
    expect(h.getThreadLessonsState).toHaveBeenCalledTimes(2);
    expect(h.mark()).toBe('reflecting');

    await h.elapse(LESSONS_POLL_MS);
    expect(h.getThreadLessonsState).toHaveBeenCalledTimes(3);
    expect(h.mark()).toBe('ready');

    await h.elapse(LESSONS_POLL_MS * 4);
    expect(h.getThreadLessonsState).toHaveBeenCalledTimes(3);
  });

  it('reads again when a reflection was just started', async () => {
    const h = harness(null);
    await h.render('source');
    expect(h.getThreadLessonsState).toHaveBeenCalledTimes(1);

    await h.render('source', 1);

    expect(h.getThreadLessonsState).toHaveBeenCalledTimes(2);
  });

  it('reads again when the thread’s own turn ends, and not for another thread or a turn starting', async () => {
    const h = harness([
      () => Promise.resolve(NOTHING_NEW),
      () => Promise.resolve(READY),
    ]);
    await h.render('source');
    expect(h.mark()).toBe('nothing_new');

    await h.status('source', 'running');
    await h.status('other', 'completed');
    expect(h.getThreadLessonsState).toHaveBeenCalledTimes(1);

    await h.status('source', 'completed');

    expect(h.getThreadLessonsState).toHaveBeenCalledTimes(2);
    expect(h.mark()).toBe('ready');
  });
});
