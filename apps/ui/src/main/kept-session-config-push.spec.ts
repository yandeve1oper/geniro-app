import { describe, expect, it } from 'vitest';

import type { DaemonHandle } from '../shared/contracts';
import { KeptSessionConfigPush } from './kept-session-config-push';

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

describe('KeptSessionConfigPush', () => {
  it('PUTs the idle window and limit to the daemon with the launch token', async () => {
    const http = recordingFetch();
    await new KeptSessionConfigPush(() => undefined, http.fetchImpl).push(
      HANDLE,
      { idleMinutes: 5, limit: 24 },
    );

    expect(http.calls).toHaveLength(1);
    const [call] = http.calls;
    expect(call?.url).toBe('http://127.0.0.1:47615/v1/agents/sessions/config');
    expect(call?.init.method).toBe('PUT');
    expect(call?.init.headers).toMatchObject({
      authorization: 'Bearer launch-token',
    });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      idleMinutes: 5,
      limit: 24,
    });
  });

  it('sends only settings the daemon does not already hold', async () => {
    const http = recordingFetch();
    const push = new KeptSessionConfigPush(() => undefined, http.fetchImpl);
    await push.push(HANDLE, { idleMinutes: 60, limit: null });

    await push.pushIfChanged(HANDLE, { idleMinutes: 60, limit: null });
    await push.pushIfChanged(HANDLE, { idleMinutes: 60, limit: 8 });

    expect(http.calls).toHaveLength(2);
    expect(JSON.parse(String(http.calls[1]?.init.body))).toEqual({
      idleMinutes: 60,
      limit: 8,
    });
  });

  it('names the refused value and retries it on the next write', async () => {
    const reports: string[] = [];
    const refusing = recordingFetch(400);
    const push = new KeptSessionConfigPush(
      (m) => reports.push(m),
      refusing.fetchImpl,
    );

    await push.push(HANDLE, { idleMinutes: 60, limit: null });
    await push.pushIfChanged(HANDLE, { idleMinutes: 60, limit: null });

    expect(reports[0]).toContain(
      'the daemon refused the kept-session settings (400)',
    );
    expect(refusing.calls).toHaveLength(2);
  });
});
