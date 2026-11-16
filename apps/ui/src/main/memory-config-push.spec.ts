import { describe, expect, it } from 'vitest';

import { type DaemonHandle, DEFAULT_SETTINGS } from '../shared/contracts';
import { memoryConfigOf, MemoryConfigPush } from './memory-config-push';

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

describe('MemoryConfigPush', () => {
  it('PUTs the memory settings to the daemon with the launch token', async () => {
    const http = recordingFetch();
    await new MemoryConfigPush(() => undefined, http.fetchImpl).push(HANDLE, {
      enabled: false,
      agentWrites: 'pending',
      nativeMemoryOff: false,
      autoForgetAfterDays: 30,
      removeNotUseful: false,
    });

    expect(http.calls).toHaveLength(1);
    const [call] = http.calls;
    expect(call?.url).toBe('http://127.0.0.1:47615/v1/memories/config');
    expect(call?.init.method).toBe('PUT');
    expect(call?.init.headers).toMatchObject({
      authorization: 'Bearer launch-token',
    });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      enabled: false,
      agentWrites: 'pending',
      nativeMemoryOff: false,
      autoForgetAfterDays: 30,
      removeNotUseful: false,
    });
  });

  it('pushes the sweep switches beside the memory settings, as autoForgetAfterDays and removeNotUseful', () => {
    expect(
      memoryConfigOf({
        memory: { enabled: true, agentWrites: 'active', nativeMemoryOff: true },
        memoryAutoForgetAfterDays: 14,
        memoryRemoveNotUseful: false,
      }),
    ).toEqual({
      enabled: true,
      agentWrites: 'active',
      nativeMemoryOff: true,
      autoForgetAfterDays: 14,
      removeNotUseful: false,
    });
    expect(memoryConfigOf(DEFAULT_SETTINGS).autoForgetAfterDays).toBeNull();
    expect(memoryConfigOf(DEFAULT_SETTINGS).removeNotUseful).toBe(true);
  });

  it('pushes again when only a sweep switch changes, and not for an unrelated write', async () => {
    const http = recordingFetch();
    const push = new MemoryConfigPush(() => undefined, http.fetchImpl);
    const before = memoryConfigOf(DEFAULT_SETTINGS);

    await push.pushIfChanged(HANDLE, before);
    await push.pushIfChanged(HANDLE, { ...before });
    expect(http.calls).toHaveLength(1);

    await push.pushIfChanged(
      HANDLE,
      memoryConfigOf({ ...DEFAULT_SETTINGS, memoryAutoForgetAfterDays: 14 }),
    );
    expect(http.calls).toHaveLength(2);
    expect(JSON.parse(String(http.calls[1]?.init.body))).toMatchObject({
      autoForgetAfterDays: 14,
    });

    await push.pushIfChanged(
      HANDLE,
      memoryConfigOf({ ...DEFAULT_SETTINGS, memoryRemoveNotUseful: false }),
    );
    expect(http.calls).toHaveLength(3);
    expect(JSON.parse(String(http.calls[2]?.init.body))).toMatchObject({
      removeNotUseful: false,
    });
  });

  it('names the refused settings and retries them on the next write', async () => {
    const reports: string[] = [];
    const refusing = recordingFetch(400);
    const push = new MemoryConfigPush(
      (m) => reports.push(m),
      refusing.fetchImpl,
    );
    const config = {
      enabled: true,
      agentWrites: 'active' as const,
      nativeMemoryOff: false,
      autoForgetAfterDays: null,
      removeNotUseful: true,
    };

    await push.push(HANDLE, config);
    await push.pushIfChanged(HANDLE, config);

    expect(reports[0]).toContain(
      'the daemon refused the memory settings (400)',
    );
    expect(refusing.calls).toHaveLength(2);
  });
});
