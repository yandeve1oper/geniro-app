// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';
import {
  askingKey,
  type AskingThread,
  askKindOf,
  askLineOf,
  type OpenRequestsState,
  useOpenRequests,
} from './use-open-requests';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const THREADS: AskingThread[] = [
  {
    runId: 'run-1',
    title: 'Long worker',
    isTeam: false,
    awaiting: 'question',
    lastActivityAt: '2026-11-17T12:00:00.000Z',
  },
  {
    runId: 'run-2',
    title: 'Release team',
    isTeam: true,
    awaiting: 'approval',
    lastActivityAt: '2026-11-17T12:01:00.000Z',
  },
];

function fakes() {
  const readRunState = vi.fn(({ runId }: { runId: string }) =>
    Promise.resolve({
      openRequests: [
        {
          id: `item-${runId}`,
          runId,
          kind: 'approval_request',
          payload: { id: `req-${runId}`, toolName: 'Bash' },
        },
      ],
    }),
  );
  const sendChatMessage = vi.fn(() => Promise.resolve({}));
  const sendTeamRunMessage = vi.fn(() => Promise.resolve({}));
  const sendVerdict = vi.fn();
  const apis = {
    chats: { readRunState, sendChatMessage },
    teams: { sendTeamRunMessage },
  } as unknown as DaemonApis;
  const client = { sendVerdict } as unknown as DaemonClient;
  return {
    apis,
    client,
    readRunState,
    sendChatMessage,
    sendTeamRunMessage,
    sendVerdict,
  };
}

async function mount(
  apis: DaemonApis,
  client: DaemonClient,
  threads: AskingThread[],
): Promise<{ current: OpenRequestsState }> {
  const state = { current: null as unknown as OpenRequestsState };
  function Probe(): null {
    state.current = useOpenRequests(apis, client, threads);
    return null;
  }
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return state;
}

describe('askingKey', () => {
  it('moves when a thread starts or stops waiting, or writes a new row', () => {
    const key = askingKey(THREADS);

    expect(askingKey([...THREADS].reverse())).toBe(key);
    expect(askingKey(THREADS.slice(0, 1))).not.toBe(key);
    expect(
      askingKey([
        { ...THREADS[0]!, lastActivityAt: '2026-11-17T12:05:00.000Z' },
        THREADS[1]!,
      ]),
    ).not.toBe(key);
  });
});

describe('useOpenRequests', () => {
  it('reads each waiting thread’s open cards from its own run state', async () => {
    const { apis, client, readRunState } = fakes();
    const state = await mount(apis, client, THREADS);

    expect(readRunState).toHaveBeenCalledTimes(2);
    expect(
      state.current.requests.map((request) => [
        request.runId,
        request.requestId,
        request.title,
      ]),
    ).toEqual([
      ['run-1', 'req-run-1', 'Long worker'],
      ['run-2', 'req-run-2', 'Release team'],
    ]);
  });

  it('answers through the thread’s own verdict channel and drops the card at once', async () => {
    const { apis, client, sendVerdict } = fakes();
    const state = await mount(apis, client, THREADS);

    await act(async () => {
      state.current.answer(state.current.requests[0]!, true, 'Red');
    });

    expect(sendVerdict).toHaveBeenCalledWith('run-1', 'req-run-1', true, 'Red');
    expect(state.current.requests.map((request) => request.runId)).toEqual([
      'run-2',
    ]);
  });

  it('passes a picked permission option along with the verdict', async () => {
    const { apis, client, sendVerdict } = fakes();
    const state = await mount(apis, client, THREADS);

    await act(async () => {
      state.current.answer(
        state.current.requests[1]!,
        true,
        undefined,
        undefined,
        'allow-session',
      );
    });

    expect(sendVerdict).toHaveBeenCalledWith(
      'run-2',
      'req-run-2',
      true,
      undefined,
      'allow-session',
    );
  });

  it('sends pasted screenshots as the thread’s next message, to a chat or a team run', async () => {
    const { apis, client, sendChatMessage, sendTeamRunMessage } = fakes();
    const state = await mount(apis, client, THREADS);
    const images = [{ mediaType: 'image/png', data: 'AAAA' }];

    const [chat, team] = state.current.requests;
    await act(async () => {
      state.current.answer(chat!, true, 'see the picture', images as never);
    });
    await act(async () => {
      state.current.answer(team!, true, 'and this one', images as never);
    });

    expect(sendChatMessage).toHaveBeenCalledWith({
      runId: 'run-1',
      sendMessageDto: { text: '', images },
    });
    expect(sendTeamRunMessage).toHaveBeenCalledTimes(1);
    expect(sendTeamRunMessage).toHaveBeenCalledWith({
      runId: 'run-2',
      sendMessageDto: { text: '', images },
    });
  });
});

describe('askLineOf and askKindOf', () => {
  const requestWith = (payload: Record<string, unknown>) => ({
    runId: 'run-1',
    title: 'Long worker',
    isTeam: false,
    requestId: 'req-1',
    item: { payload } as never,
  });

  it('names the question a thread asks', () => {
    const request = requestWith({
      toolName: 'AskUserQuestion',
      questions: [{ question: 'Which colour do you want?', options: [] }],
    });

    expect(askKindOf(request)).toBe('question');
    expect(askLineOf(request)).toBe('Asks: Which colour do you want?');
  });

  it('names the command an approval holds, else the tool', () => {
    const bash = requestWith({
      toolName: 'Bash',
      input: { command: 'ls -la' },
    });
    const edit = requestWith({ toolName: 'Edit', input: { file_path: 'a' } });

    expect(askKindOf(bash)).toBe('approval');
    expect(askLineOf(bash)).toBe('Wants to run: ls -la');
    expect(askLineOf(edit)).toBe('Wants to use Edit');
  });
});
