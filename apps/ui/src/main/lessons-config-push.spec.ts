import { describe, expect, it } from 'vitest';

import type { DaemonHandle } from '../shared/contracts';
import { LessonsConfigPush } from './lessons-config-push';

const HANDLE: DaemonHandle = {
  host: '127.0.0.1',
  port: 47615,
  token: 'launch-token',
  version: '0.0.0',
  startedAt: new Date(0).toISOString(),
};

function recordingFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response('{}', { status }));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('LessonsConfigPush', () => {
  it('PUTs the lessons settings to the daemon with the launch token', async () => {
    const http = recordingFetch();
    await new LessonsConfigPush(() => undefined, http.fetchImpl).push(HANDLE, {
      mode: 'off',
      agentKind: 'codex',
      model: 'gpt-5-mini',
      effort: 'low',
    });

    expect(http.calls).toHaveLength(1);
    const [call] = http.calls;
    expect(call?.url).toBe('http://127.0.0.1:47615/v1/lessons/config');
    expect(call?.init.method).toBe('PUT');
    expect(call?.init.headers).toMatchObject({
      authorization: 'Bearer launch-token',
    });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      mode: 'off',
      agentKind: 'codex',
      model: 'gpt-5-mini',
      effort: 'low',
    });
  });

  it('names the refused settings and retries them on the next write', async () => {
    const reports: string[] = [];
    const refusing = recordingFetch(400);
    const push = new LessonsConfigPush(
      (message) => reports.push(message),
      refusing.fetchImpl,
    );

    const settings = {
      mode: 'offer' as const,
      agentKind: null,
      model: null,
      effort: null,
    };
    await push.push(HANDLE, settings);
    await push.pushIfChanged(HANDLE, settings);

    expect(reports[0]).toContain(
      'the daemon refused the lessons settings (400)',
    );
    expect(refusing.calls).toHaveLength(2);
  });
});
