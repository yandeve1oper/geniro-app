import { io, type Socket } from 'socket.io-client';

import type { DaemonHandle } from '../shared/contracts';

/** Why the daemon is held open: an armed project's autopilot, or an approved thread start waiting. */
export type KeepAliveReason = 'armed-project' | 'thread-start';

/**
 * One socket, held open so the daemon does not idle out while the autopilot
 * still has work to do.
 *
 * `IdleShutdownLifecycle` exits the daemon after `GENIRO_IDLE_EXIT_MS` with no
 * connected client AND no turn in flight, and `DaemonSupervisor` passes that
 * window to every daemon it spawns — so it is live in the shipped app. While a
 * window is open the renderer's own socket already holds the count above zero
 * and nothing here matters. The gap is the ordinary macOS state: the app
 * running with every window closed, a project armed, and one task just
 * finished. No client, no turn, and the queue stops for good.
 *
 * It holds a CLIENT connection rather than reaching into the daemon's idle
 * rule, because the rule is already the right one — "nobody is using me and
 * nothing is running" — and the autopilot simply is a user of it. The daemon
 * needs no knowledge of any of this.
 *
 * The socket carries the per-launch bearer token because the handshake gate
 * (`auth/ws-auth.ts`) disconnects an unauthenticated client, and a disconnected
 * client is not counted in `presence.connected` — so an unauthenticated socket
 * would keep nothing alive while looking exactly like it did.
 *
 * It lives in the Electron MAIN process, so quitting the app closes it and the
 * daemon goes back to its ordinary idle window. This can keep a daemon alive
 * past the last window; it cannot keep one alive past the app.
 */
export class DaemonKeepAlive {
  private socket: Socket | null = null;
  private handle: DaemonHandle | null = null;
  private readonly reasons = new Set<KeepAliveReason>();

  constructor(
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  /**
   * Point at the daemon currently running, or at none.
   *
   * Called on every supervisor state change: a daemon that was replaced is a
   * different process with a different token, so the old socket is dropped
   * rather than reconnected — reconnecting would authenticate against a token
   * that no longer exists and be disconnected on the handshake.
   */
  useDaemon(handle: DaemonHandle | null): void {
    const sameLaunch =
      this.handle !== null &&
      handle !== null &&
      this.handle.port === handle.port &&
      this.handle.token === handle.token &&
      this.handle.startedAt === handle.startedAt;
    if (sameLaunch) {
      return;
    }
    this.handle = handle;
    this.close();
    if (this.wanted) {
      this.open();
    }
  }

  /**
   * Whether any project is armed right now.
   */
  setArmed(armed: boolean): void {
    this.hold('armed-project', armed);
  }

  /**
   * Hold the daemon open for one reason, or let that reason go.
   *
   * The socket is open while ANY reason holds, and closed when the last one
   * lets go. One socket answers for all of them: the daemon's idle rule counts
   * connections, not reasons, so a second socket would keep nothing extra alive.
   */
  hold(reason: KeepAliveReason, held: boolean): void {
    const before = this.wanted;
    if (held) {
      this.reasons.add(reason);
    } else {
      this.reasons.delete(reason);
    }
    if (this.wanted === before) {
      return;
    }
    if (this.wanted) {
      this.open();
    } else {
      this.close();
    }
  }

  private get wanted(): boolean {
    return this.reasons.size > 0;
  }

  /** Whether a socket is currently held. Read by specs and the boot log. */
  get held(): boolean {
    return this.socket !== null;
  }

  /** Drop the socket on the way out; the app quitting is not an armed state. */
  dispose(): void {
    this.reasons.clear();
    this.close();
  }

  private open(): void {
    if (this.socket !== null || this.handle === null) {
      return;
    }
    const handle = this.handle;
    this.socket = io(`http://${handle.host}:${handle.port}`, {
      path: '/ws',
      transports: ['websocket'],
      auth: { token: handle.token },
      // Reconnect on its own: a daemon restart is exactly when a queue is
      // most likely to stall, and the alternative is polling for one.
      reconnection: true,
    });
    this.log(`holding the daemon open on ${handle.host}:${handle.port}`);
  }

  private close(): void {
    if (this.socket === null) {
      return;
    }
    this.socket.close();
    this.socket = null;
    this.log('released the daemon');
  }
}
