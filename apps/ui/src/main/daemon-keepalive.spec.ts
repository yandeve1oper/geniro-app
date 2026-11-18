import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle } from '../shared/contracts';

const { io, closes } = vi.hoisted(() => {
  const closes: string[] = [];
  return {
    closes,
    io: vi.fn((url: string) => ({
      close: vi.fn(() => {
        closes.push(url);
      }),
    })),
  };
});

vi.mock('socket.io-client', () => ({ io }));

const { DaemonKeepAlive } = await import('./daemon-keepalive');

const handle = (over: Partial<DaemonHandle> = {}): DaemonHandle => ({
  host: '127.0.0.1',
  port: 47615,
  token: 'tok-1',
  version: '0.1.0',
  startedAt: '2026-09-07T12:00:00.000Z',
  ...over,
});

/**
 * The daemon exits after its idle window with no connected client and no turn
 * in flight. Holding one authenticated client is the whole mechanism, so what
 * these pin is when a socket exists — not what travels over it, which is
 * nothing.
 */
describe('DaemonKeepAlive', () => {
  beforeEach(() => {
    io.mockClear();
    closes.length = 0;
  });

  it('holds nothing until a project is armed', () => {
    const keepAlive = new DaemonKeepAlive();
    keepAlive.useDaemon(handle());

    expect(keepAlive.held).toBe(false);
    expect(io).not.toHaveBeenCalled();
  });

  // The token is the point, not a detail: `enforceWsHandshakeAuth` disconnects
  // an unauthenticated client, and a disconnected client is not counted in
  // `presence.connected` — so an unauthenticated socket would keep nothing
  // alive while looking exactly like one that did.
  it('opens an authenticated socket on the daemon’s own port when armed', () => {
    const keepAlive = new DaemonKeepAlive();
    keepAlive.useDaemon(handle());

    keepAlive.setArmed(true);

    expect(keepAlive.held).toBe(true);
    expect(io).toHaveBeenCalledTimes(1);
    expect(io).toHaveBeenCalledWith(
      'http://127.0.0.1:47615',
      expect.objectContaining({
        path: '/ws',
        auth: { token: 'tok-1' },
      }),
    );
  });

  it('releases the daemon when the last project is disarmed', () => {
    const keepAlive = new DaemonKeepAlive();
    keepAlive.useDaemon(handle());
    keepAlive.setArmed(true);

    keepAlive.setArmed(false);

    expect(keepAlive.held).toBe(false);
    expect(closes).toEqual(['http://127.0.0.1:47615']);
  });

  // An armed project and a waiting thread start are two reasons, one socket:
  // the socket stays while either holds, and closes only when the last lets go.
  it('keeps the daemon held while any reason holds, and releases after the last', () => {
    const keepAlive = new DaemonKeepAlive();
    keepAlive.useDaemon(handle());

    keepAlive.hold('thread-start', true);
    keepAlive.setArmed(true);
    expect(io).toHaveBeenCalledTimes(1);

    keepAlive.hold('thread-start', false);
    expect(keepAlive.held).toBe(true);
    expect(closes).toEqual([]);

    keepAlive.setArmed(false);
    expect(keepAlive.held).toBe(false);
    expect(closes).toEqual(['http://127.0.0.1:47615']);
  });

  it('holds ONE socket however many times arming is restated', () => {
    const keepAlive = new DaemonKeepAlive();
    keepAlive.useDaemon(handle());

    keepAlive.setArmed(true);
    keepAlive.setArmed(true);
    keepAlive.setArmed(true);

    expect(io).toHaveBeenCalledTimes(1);
  });

  it('waits for a daemon when armed before one exists, then opens', () => {
    const keepAlive = new DaemonKeepAlive();

    keepAlive.setArmed(true);
    expect(keepAlive.held).toBe(false);

    keepAlive.useDaemon(handle());
    expect(keepAlive.held).toBe(true);
  });

  // A replaced daemon is a different process with a different token. Keeping
  // the socket would leave it authenticating against a token that no longer
  // exists, and being disconnected on the handshake — which is the failure
  // that looks most like success, since `held` would still read true.
  it('moves the socket to a relaunched daemon', () => {
    const keepAlive = new DaemonKeepAlive();
    keepAlive.useDaemon(handle());
    keepAlive.setArmed(true);

    keepAlive.useDaemon(
      handle({
        port: 47616,
        token: 'tok-2',
        startedAt: '2026-09-07T13:00:00.000Z',
      }),
    );

    expect(closes).toEqual(['http://127.0.0.1:47615']);
    expect(io).toHaveBeenLastCalledWith(
      'http://127.0.0.1:47616',
      expect.objectContaining({ auth: { token: 'tok-2' } }),
    );
    expect(io).toHaveBeenCalledTimes(2);
  });

  it('does not churn the socket when the same launch is restated', () => {
    const keepAlive = new DaemonKeepAlive();
    keepAlive.useDaemon(handle());
    keepAlive.setArmed(true);

    keepAlive.useDaemon(handle());

    expect(io).toHaveBeenCalledTimes(1);
    expect(closes).toEqual([]);
  });

  it('drops the socket when the daemon goes away', () => {
    const keepAlive = new DaemonKeepAlive();
    keepAlive.useDaemon(handle());
    keepAlive.setArmed(true);

    keepAlive.useDaemon(null);

    expect(keepAlive.held).toBe(false);
    expect(closes).toEqual(['http://127.0.0.1:47615']);
  });

  // Quitting is not an armed state: the daemon goes back to its ordinary idle
  // window rather than being held open by a process that is ending.
  it('releases on dispose and stays released', () => {
    const keepAlive = new DaemonKeepAlive();
    keepAlive.useDaemon(handle());
    keepAlive.setArmed(true);

    keepAlive.dispose();
    keepAlive.useDaemon(handle({ port: 47617 }));

    expect(keepAlive.held).toBe(false);
    expect(io).toHaveBeenCalledTimes(1);
  });
});
