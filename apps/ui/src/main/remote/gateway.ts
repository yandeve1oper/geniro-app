import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer, request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { join, resolve as resolvePath, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { DaemonHandle } from '../../shared/contracts';
import {
  REMOTE_ROUTE_BRIDGE,
  REMOTE_ROUTE_EVENTS,
  REMOTE_ROUTE_PAIR,
  REMOTE_ROUTE_PREFIX,
  REMOTE_ROUTE_SESSION,
  REMOTE_SESSION_COOKIE,
  type RemoteDevice,
  type RemoteGatewayState,
} from '../../shared/remote';
import type { IpcRegistry } from '../ipc-registry';
import { isArtifactMediaRequest } from './artifact-media-request';
import {
  createCompressor,
  encodedHeaders,
  hasBody,
  isCompressible,
  negotiateEncoding,
} from './compression';
import { type ProxiedUpgrade, proxyHttp, proxyUpgrade } from './daemon-proxy';
import type { DeviceRegistry } from './device-registry';
import { isAllowedHost } from './host-guard';
import { buildRemoteLinks } from './net-links';
import type { Pairing } from './pairing';
import { REMOTE_PREFERRED_PORT } from './remote.types';
import {
  createRemoteRoutes,
  parseCookies,
  readJsonBody,
  type RouteRequest,
  type RouteResult,
} from './remote-routes';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) {
    return 'application/octet-stream';
  }
  return CONTENT_TYPES[path.slice(dot)] ?? 'application/octet-stream';
}

/**
 * Where vite writes the build's content-hashed chunks. A file there never
 * changes under its name — a rebuild writes a NEW name — so it may be cached
 * for good, and a request for one that is missing is a stale page asking for
 * an old build, never a navigation.
 */
const HASHED_ASSETS_PREFIX = '/assets/';

/**
 * Whether a request names a FILE rather than a page to navigate to: anything
 * under the hashed-assets directory, or a last segment carrying an extension.
 * Only a navigation may be answered with `index.html`.
 */
function isFileRequest(pathname: string): boolean {
  if (pathname.startsWith(HASHED_ASSETS_PREFIX)) {
    return true;
  }
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return last.includes('.');
}

/**
 * The page itself is never stored: it is what names the build's chunks, so a
 * copy kept past an update — a reload, a restored tab — asks for chunks the
 * gateway no longer has. The chunks are named by their content and are kept
 * for good; anything else is revalidated.
 */
function cacheControlFor(pathname: string, filePath: string): string {
  if (filePath.endsWith('index.html')) {
    return 'no-store';
  }
  if (pathname.startsWith(HASHED_ASSETS_PREFIX)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

function isoOrNull(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

export interface GatewayOptions {
  pairing: Pairing;
  deviceRegistry: DeviceRegistry;
  ipcRegistry: IpcRegistry;
  /** Read fresh on every proxied call — a daemon restart rotates host/port/token. */
  daemonHandle: () => DaemonHandle | null;
  /** Where the packaged renderer bundle lives (`out/renderer`). */
  staticRoot: string;
  /**
   * When set, static requests are proxied to this origin (vite's own dev
   * server) instead of the filesystem — `staticRoot` does not exist in
   * development at all.
   */
  devServerUrl?: string;
  /** Test seam; defaults to {@link REMOTE_PREFERRED_PORT}. */
  preferredPort?: number;
  /** Test seam; defaults to `[os.hostname()]`. */
  allowedHostNames?: readonly string[];
  /**
   * Host patterns to admit ON TOP of {@link allowedHostNames}, read FRESH on
   * every request.
   *
   * A function rather than an array because what it answers changes while the
   * listener runs: it is how an open tunnel's `*.suffix` reaches the guard,
   * and closing that tunnel has to stop admitting the suffix at once rather
   * than at the next restart. Empty whenever no tunnel is open, so the guard
   * is exactly as narrow as it was before this existed.
   */
  extraAllowedHosts?: () => readonly string[];
}

/**
 * The LAN gateway's HTTP listener: serves the renderer bundle, reverse-proxies
 * the daemon, and answers the pairing/bridge/events routes — all from Electron
 * MAIN, since the daemon itself binds `127.0.0.1` only and that constraint is
 * not this module's to relax. Styled on `terminal-sessions.ts`: options as
 * test seams, an explicit `start`/`stop`, no module-level singletons.
 */
export class RemoteGateway {
  private server: Server | null = null;
  /** An in-flight `stop()`, so `start()` cannot race a listener still closing. */
  private stopping: Promise<void> | null = null;
  /**
   * Every proxied `/ws` pair still open, keyed by the browser's socket and
   * tagged with the device whose cookie opened it.
   *
   * The server cannot answer for these itself: once a socket is upgraded,
   * `closeAllConnections()` no longer sees it while `close()` still waits on
   * it, and pairing is asked only at the handshake. So without this record an
   * open phone tab made `stop()` a promise that never settled — switching
   * remote access OFF hung, and so did quitting — and revoking a stolen phone
   * left its tab holding a live socket to the daemon, with the daemon's token
   * already injected into it.
   */
  private readonly upgrades = new Map<
    Socket,
    { deviceId: string; upgrade: ProxiedUpgrade }
  >();
  private readonly routes: ReturnType<typeof createRemoteRoutes>;

  constructor(private readonly options: GatewayOptions) {
    this.routes = createRemoteRoutes({
      pairing: options.pairing,
      deviceRegistry: options.deviceRegistry,
      ipcRegistry: options.ipcRegistry,
    });
  }

  async start(): Promise<void> {
    // A listener still closing still holds the port, so binding before it is
    // released loses the preferred one to `EADDRINUSE` and silently falls
    // back to a random port.
    await this.stopping;
    if (this.server) {
      return;
    }
    const server = createServer((req, res) => this.handleRequest(req, res));
    server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) =>
      this.handleUpgrade(req, socket, head),
    );
    await this.listen(
      server,
      this.options.preferredPort ?? REMOTE_PREFERRED_PORT,
    );
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return this.stopping ?? undefined;
    }
    // The field is cleared only once the socket is actually released. Nulling
    // it up front let a fast off→on toggle see `server === null`, bind a
    // SECOND listener, lose 47616 to the one still closing, and fall back to
    // a random port — after which every printed link and QR named a port
    // nothing would answer on.
    this.stopping = (async () => {
      // `close()` stops accepting and then WAITS for every open connection —
      // and this gateway deliberately holds long-lived ones: an SSE stream that
      // only ever ends when the phone closes its tab, and a proxied WebSocket.
      // Without this, one open phone tab makes `stop()` a promise that never
      // settles, which `before-quit` awaits (the app cannot quit) and the
      // Settings switch awaits too (turning remote access OFF hangs forever
      // with the port still open).
      server.closeAllConnections();
      // …which reaches every connection EXCEPT an upgraded one: Node drops a
      // socket from the set it closes the moment it is handed to `upgrade`,
      // while `close()` goes on waiting for it. Measured on Node 24, one open
      // `/ws` kept `close()` from ever calling back.
      for (const { upgrade } of this.upgrades.values()) {
        upgrade.close();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.server = null;
      this.stopping = null;
    })();
    return this.stopping;
  }

  /**
   * Ends every proxied `/ws` a device holds open. Revoking a device removes
   * its registry row, which refuses its NEXT request — but a socket is
   * authorized once, at the handshake, so one already open would otherwise
   * outlive the revoke with the daemon's own credential behind it.
   */
  disconnectDevice(deviceId: string): void {
    for (const entry of this.upgrades.values()) {
      if (entry.deviceId === deviceId) {
        entry.upgrade.close();
      }
    }
  }

  /** The bound port, or `null` when the server is not listening. */
  port(): number | null {
    if (!this.server) {
      return null;
    }
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      return null;
    }
    return address.port;
  }

  /** What the listener itself can answer — see `RemoteGatewayState`. */
  state(): RemoteGatewayState {
    const port = this.port();
    const links =
      port !== null
        ? buildRemoteLinks(port, {
            hostname: hostname(),
            interfaces: networkInterfaces(),
          })
        : { hostUrl: null, addressUrl: null };
    const listening = port !== null;
    return {
      // This module has no access to `Settings.remoteAccessEnabled` (that is
      // main/index.ts's to read) — `enabled` here answers the only question
      // this class can: whether the listener is actually up.
      enabled: listening,
      listening,
      port,
      hostUrl: links.hostUrl,
      addressUrl: links.addressUrl,
      pairingCode: listening ? this.options.pairing.currentCode() : null,
      pairingCodeExpiresAt: listening
        ? isoOrNull(this.options.pairing.codeExpiresAt())
        : null,
      devices: this.options.deviceRegistry.list(),
      unavailableReason: listening ? null : 'not listening',
    };
  }

  private listen(server: Server, preferredPort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        if (err.code === 'EADDRINUSE' && preferredPort !== 0) {
          server.removeListener('error', onError);
          // 0 asks the OS for any free port — the fallback this exists for.
          server.listen(0, '0.0.0.0', () => resolve());
          return;
        }
        reject(err);
      };
      server.once('error', onError);
      // IPv4 ONLY, deliberately: the host guard (`host-guard.ts`) refuses
      // any globally-routable IPv6 literal, because SLAAC routinely hands a
      // Mac one and accepting it would publish this LAN-only listener to
      // the open internet. Binding `0.0.0.0` rather than `::` means such a
      // request has no socket to arrive on in the first place — the guard
      // and the bind are two layers of the same refusal, not one relying on
      // the other.
      server.listen(preferredPort, '0.0.0.0', () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
  }

  /**
   * The guard's input, built in ONE place.
   *
   * Both callers — the request path and the upgrade path — used to spell this
   * object out for themselves, which is how a widening comes to reach one of
   * them and not the other: an upgrade that ignored the tunnel's host pattern
   * would leave a phone on the public address able to list chats and unable
   * to watch one, the exact shape of a bug this directory has already had.
   */
  private guardOptions(port: number): {
    port: number;
    allowedHostNames: readonly string[];
  } {
    return {
      port,
      allowedHostNames: [
        ...(this.options.allowedHostNames ?? [hostname()]),
        ...(this.options.extraAllowedHosts?.() ?? []),
      ],
    };
  }

  private hostAllowed(req: IncomingMessage): boolean {
    const port = this.port();
    if (port === null) {
      return false;
    }
    return isAllowedHost(req.headers.host, this.guardOptions(port));
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!this.hostAllowed(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden host');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://internal');
    void this.route(req, res, url);
  }

  private handleUpgrade(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void {
    // The Host guard applies to the upgrade path too — an upgrade that
    // skipped it would be exactly the DNS-rebinding hole the guard exists
    // to close, just reached over `/ws` instead of an ordinary fetch.
    if (!this.hostAllowed(req)) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://internal');
    // `/ws` AND `/ws/…`, because engine.io asks for the trailing-slash form
    // and the daemon answers only that form. Matching `'/ws'` exactly dropped
    // every real handshake at the gateway while still looking correct: the
    // socket was destroyed before anything was proxied, so the phone got a
    // hang-up, a permanent "Not connected to the local engine" banner and
    // `timed out joining run` — it could list chats and start one but never
    // watch it. Measured against a real `ws` client: the daemon answers
    // `/ws/?EIO=4` with 101 and hangs up on `/ws?EIO=4`, so the two ends were
    // admitting mutually exclusive shapes. The path is forwarded verbatim by
    // `proxyUpgrade` (it rewrites only the token query), which is what keeps
    // the daemon's own form intact.
    if (url.pathname !== '/ws' && !url.pathname.startsWith('/ws/')) {
      socket.destroy();
      return;
    }
    // A WebSocket upgrade is NOT subject to the same-origin policy, so the
    // cookie alone does not say the page asking for it is ours: any page in
    // any browser on this network can open one and the browser will attach
    // the cookie. The Origin header is what distinguishes them, and a
    // handshake carrying a foreign one is refused before the pairing check.
    if (!this.originAllowed(req)) {
      socket.destroy();
      return;
    }
    const device = this.pairedDevice(req);
    if (!device) {
      socket.destroy();
      return;
    }
    const handle = this.options.daemonHandle();
    if (!handle) {
      socket.destroy();
      return;
    }
    const upgrade = proxyUpgrade(req, socket, head, handle);
    // Tagged with the DEVICE rather than the cookie, because a revoke names a
    // device id. The pair's own teardown destroys this socket on every path,
    // so its `close` is the one place the record can be retired.
    this.upgrades.set(socket, { deviceId: device.id, upgrade });
    socket.once('close', () => this.upgrades.delete(socket));
  }

  /**
   * The paired device this request's cookie names, or `null`.
   *
   * THE authorization question, asked at one seam and on every surface.
   * It used to be asked inside `createRemoteRoutes` alone, which guarded the
   * bridge and the event stream and left the two that actually matter — the
   * daemon proxy and the `/ws` upgrade — open to anyone on the network, with
   * the daemon's own bearer token injected on their behalf.
   */
  private pairedDevice(req: IncomingMessage): RemoteDevice | null {
    const token = parseCookies(req.headers.cookie)[REMOTE_SESSION_COOKIE];
    if (token === undefined || token === '') {
      return null;
    }
    return this.options.deviceRegistry.findByToken(token);
  }

  /**
   * Whether an `Origin` names this gateway itself.
   *
   * Absent is allowed: a non-browser client (curl, a native app) sends none,
   * and it has already had to present a paired cookie to get this far. What
   * is refused is a PRESENT origin that is not ours, which is the only shape
   * a hostile page can produce.
   */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) {
      return true;
    }
    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return false;
      }
      // The port is restated even when the origin omits it. An origin on its
      // scheme's default port leaves it out (`http://192.168.1.5`), and the
      // guard reads a portless value as "whatever port this socket is" —
      // right for a Host header, since that request did arrive here, and
      // wrong for an Origin, which names where the PAGE came from: port 80
      // on this Mac is a different server. A tunnel's `https://…` origin
      // still passes, because its wildcard is matched before any port.
      const port = url.port || (url.protocol === 'https:' ? '443' : '80');
      return isAllowedHost(
        `${url.hostname}:${port}`,
        this.guardOptions(
          this.port() ?? this.options.preferredPort ?? REMOTE_PREFERRED_PORT,
        ),
      );
    } catch {
      return false;
    }
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    // NO CORS headers are ever written, on any path below — not a
    // permissive one, not a reflected one. The renderer page is SERVED by
    // this same origin, so nothing here is ever answering a legitimate
    // cross-origin request, and a CORS header would only ever help an
    // illegitimate one.
    if (url.pathname.startsWith(REMOTE_ROUTE_PREFIX)) {
      await this.routeOwn(req, res, url);
      return;
    }
    // `/ws` over plain HTTP is engine.io's POLLING transport, which it falls
    // back to when a websocket cannot be established. Left to fall through,
    // it hit the static arm and was answered with `index.html` at 200 —
    // which engine.io cannot parse, so the fallback failed in the one way
    // that looks like a success. This app's own client asks for websocket
    // only, so nothing today depends on it; answering it correctly is what
    // stops the fallback being a trap for the next client that does.
    if (
      url.pathname === '/health' ||
      url.pathname.startsWith('/v1/') ||
      url.pathname === '/ws' ||
      url.pathname.startsWith('/ws/')
    ) {
      // The same Origin check the `/ws` upgrade makes, for the same reason.
      // The cookie's `SameSite` ignores PORTS, so a page served from any
      // other port on this Mac's LAN address is same-site and the browser
      // attaches the cookie to its requests here. A request with no Origin
      // is the page's own same-origin GET and passes as it always has; a
      // same-origin POST names this gateway (or the tunnel's public origin),
      // which the check admits exactly as it does for `/ws`.
      if (!this.originAllowed(req)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden origin');
        return;
      }
      // The pairing gate, on the surface that most needs it: `proxyHttp`
      // injects the daemon's bearer token, so an ungated arm here hands an
      // unpaired stranger the credential the daemon's own guard exists to
      // demand — and `POST /v1/chats` starts an agent. The one exception is a
      // page's own audio or video (`isArtifactMediaRequest`), which reaches the
      // daemon without the token and is gated by the page's own key there.
      const paired = this.pairedDevice(req) !== null;
      if (!paired && !isArtifactMediaRequest(req.method, url)) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('pair this device first');
        return;
      }
      const handle = this.options.daemonHandle();
      if (!handle) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('daemon not available');
        return;
      }
      proxyHttp(req, res, handle, { withToken: paired });
      return;
    }
    this.serveStatic(req, res, url);
  }

  private async routeOwn(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const routeReq = await this.buildRouteRequest(req);
    if (url.pathname === REMOTE_ROUTE_SESSION && req.method === 'GET') {
      this.writeResult(res, this.routes.session(routeReq));
      return;
    }
    if (url.pathname === REMOTE_ROUTE_PAIR && req.method === 'POST') {
      this.writeResult(res, this.routes.pair(routeReq));
      return;
    }
    if (url.pathname === REMOTE_ROUTE_BRIDGE && req.method === 'POST') {
      this.writeResult(res, await this.routes.bridge(routeReq));
      return;
    }
    if (url.pathname === REMOTE_ROUTE_EVENTS && req.method === 'GET') {
      this.routes.events(routeReq, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  private async buildRouteRequest(req: IncomingMessage): Promise<RouteRequest> {
    const body =
      req.method === 'POST'
        ? await readJsonBody(req).catch(() => null)
        : undefined;
    const userAgent = req.headers['user-agent'];
    return {
      headers: req.headers,
      cookies: parseCookies(req.headers.cookie),
      remoteAddress: req.socket.remoteAddress ?? 'unknown',
      userAgent: typeof userAgent === 'string' ? userAgent : undefined,
      body,
    };
  }

  private writeResult(res: ServerResponse, result: RouteResult): void {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (result.setCookie) {
      headers['set-cookie'] = result.setCookie;
    }
    res.writeHead(result.status, headers);
    res.end(JSON.stringify(result.body));
  }

  private serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): void {
    // Checked before anything else touches the filesystem or the dev
    // server: a source map is never meant for a browser that did not build
    // the bundle, and refusing it here means neither branch below has to
    // remember the rule.
    if (url.pathname.endsWith('.map')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (this.options.devServerUrl) {
      // Vite serves the whole workspace through `/@fs/`, so forwarding every
      // path would publish this machine's source tree to the network — the
      // same hazard this repo already fixed for Storybook by binding
      // loopback. Refused by prefix rather than by binding loopback here,
      // because testing the phone layout in `pnpm dev` is the one thing the
      // dev arm exists for.
      if (
        url.pathname.startsWith('/@fs/') ||
        url.pathname.startsWith('/node_modules/')
      ) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden path');
        return;
      }
      this.proxyToDevServer(req, res);
      return;
    }
    const candidate = this.resolveStaticPath(url.pathname);
    if (candidate === null) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden path');
      return;
    }
    const found = existsSync(candidate) && statSync(candidate).isFile();
    // Only a NAVIGATION falls back to the page. A missing file — a lazy chunk
    // of the build the phone's page was loaded from, after the Mac updated —
    // answered with `index.html` at 200 is HTML WebKit refuses to run as a
    // module ("Importing a module script failed."). A 404 says what
    // happened, and a tunnel's edge cache cannot keep HTML under a `.js` URL.
    if (!found && isFileRequest(url.pathname)) {
      res.writeHead(404, {
        'content-type': 'text/plain',
        'cache-control': 'no-store',
      });
      res.end('not found');
      return;
    }
    const filePath = found
      ? candidate
      : join(this.options.staticRoot, 'index.html');
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const headers = {
      'content-type': contentTypeFor(filePath),
      'cache-control': cacheControlFor(url.pathname, filePath),
      'content-length': String(statSync(filePath).size),
    };
    const encoding = hasBody(req.method, 200)
      ? negotiateEncoding(req.headers['accept-encoding'])
      : null;
    if (encoding === null || !isCompressible(headers)) {
      res.writeHead(200, headers);
      pipeline(createReadStream(filePath), res).catch(() => res.destroy());
      return;
    }
    res.writeHead(200, encodedHeaders(headers, encoding));
    pipeline(createReadStream(filePath), createCompressor(encoding), res).catch(
      () => res.destroy(),
    );
  }

  /**
   * Resolves a request path inside `staticRoot`, refusing anything that
   * would land outside it. The check is SEGMENT-wise (`root + sep`), not a
   * bare `startsWith(root)` — a sibling directory whose name merely begins
   * with the root's (`out/renderer` vs `out/renderer-evil`) would otherwise
   * be admitted by a prefix match that never checks for the separator.
   */
  private resolveStaticPath(pathname: string): string | null {
    const root = resolvePath(this.options.staticRoot);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    const candidate = resolvePath(root, `.${decoded}`);
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      return null;
    }
    return candidate;
  }

  private proxyToDevServer(req: IncomingMessage, res: ServerResponse): void {
    const target = new URL(req.url ?? '/', this.options.devServerUrl);
    const upstream = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end('dev server unreachable');
    });
    req.pipe(upstream);
  }
}
