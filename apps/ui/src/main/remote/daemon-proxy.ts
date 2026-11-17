import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';
import { connect as netConnect } from 'node:net';
import { pipeline } from 'node:stream/promises';

import type { DaemonHandle } from '../../shared/contracts';
import {
  createCompressor,
  encodedHeaders,
  hasBody,
  isCompressible,
  negotiateEncoding,
} from './compression';

/**
 * How long the daemon has to answer an ordinary request before the client is
 * let go. This is a LAN gateway forwarding to a process on the same machine —
 * a daemon that has not answered in this window is hung or dead, not merely
 * slow, and a client left waiting forever on it is the actual failure mode
 * this guards against.
 */
const DAEMON_RESPONSE_TIMEOUT_MS = 30_000;

/** How long a WebSocket upgrade has to reach the daemon's loopback port. */
const DAEMON_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Stamped on every request this gateway forwards, so the daemon can refuse
 * what only the Mac's own user may do (sharing a page through their CLI
 * logins) however the phone phrases the request.
 *
 * TWIN PARSER: `REMOTE_VIA_HEADER` in `apps/daemon/src/auth/remote-marker.ts`,
 * which reads it.
 */
export const REMOTE_VIA_HEADER = 'x-geniro-via';
const REMOTE_VIA_VALUE = 'remote';

const STRIPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  REMOTE_VIA_HEADER,
]);

/**
 * Copies every header from a browser's request EXCEPT the four that must
 * never reach the daemon as the phone sent them: `authorization` and
 * `cookie` (the phone never holds the daemon's bearer token, and the
 * gateway's own pairing cookie is a fact about pairing with THIS gateway,
 * not with the daemon behind it), `host` (restated below for the
 * upstream address rather than forwarded as the phone addressed it), and
 * the remote marker, which only this gateway may set.
 */
function forwardableHeaders(
  source: IncomingMessage['headers'],
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    headers[key] = value;
  }
  return headers;
}

/**
 * Re-issues an incoming request to the loopback daemon, piping its response
 * back verbatim. The daemon's bearer token is attached HERE, never trusted
 * from the client — a phone that presented its own `Authorization` header
 * would otherwise be able to impersonate the daemon's own launch token by
 * simply sending one. `withToken: false` sends none, for a request the gateway
 * admits without pairing.
 */
export function proxyHttp(
  req: IncomingMessage,
  res: ServerResponse,
  handle: DaemonHandle,
  {
    withToken = true,
    responseTimeoutMs = DAEMON_RESPONSE_TIMEOUT_MS,
  }: { withToken?: boolean; responseTimeoutMs?: number } = {},
): void {
  const headers = forwardableHeaders(req.headers);
  if (withToken) {
    headers.authorization = `Bearer ${handle.token}`;
  }
  headers.host = `${handle.host}:${handle.port}`;
  headers[REMOTE_VIA_HEADER] = REMOTE_VIA_VALUE;

  const upstream = httpRequest({
    host: handle.host,
    port: handle.port,
    method: req.method,
    path: req.url,
    headers,
    timeout: responseTimeoutMs,
  });

  // Once the answer has started, a sentence appended to it would corrupt the
  // body (inside a compressed stream, the whole of it), so it is cut instead.
  const failUpstream = (): void => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('daemon unreachable');
  };

  // The socket-level timeout above only starts the clock; it fires as a
  // `timeout` event rather than ending the request by itself, so the request
  // must be destroyed explicitly or it hangs open past its own deadline.
  upstream.on('timeout', () => {
    upstream.destroy(new Error('daemon did not respond in time'));
  });
  upstream.on('error', failUpstream);

  upstream.on('response', (upstreamRes: IncomingMessage) => {
    const status = upstreamRes.statusCode ?? 502;
    const encoding = hasBody(req.method, status)
      ? negotiateEncoding(req.headers['accept-encoding'])
      : null;
    // `pipeline`, never `pipe`: a daemon dying mid-answer destroys
    // `upstreamRes` without an `error` on the request, and `pipe` would leave
    // the client's response open for good.
    if (encoding === null || !isCompressible(upstreamRes.headers)) {
      res.writeHead(status, upstreamRes.headers);
      pipeline(upstreamRes, res).catch(() => res.destroy());
      return;
    }
    res.writeHead(status, encodedHeaders(upstreamRes.headers, encoding));
    pipeline(upstreamRes, createCompressor(encoding), res).catch(() =>
      res.destroy(),
    );
  });

  // A client that goes away mid-request (the phone locks, the app is
  // backgrounded) must not leave the daemon-side request dangling either.
  req.on('error', () => upstream.destroy());
  res.on('close', () => {
    if (!res.writableEnded) {
      upstream.destroy();
    }
  });

  req.pipe(upstream);
}

/**
 * A live upgrade the gateway can end from OUTSIDE the pair. The caller needs
 * this because nothing else will: `server.closeAllConnections()` skips a
 * socket once it has been upgraded, while `server.close()` still waits for it,
 * and pairing is checked only at the handshake — so without a handle, neither
 * stopping the listener nor revoking the device ends a socket already open.
 */
export interface ProxiedUpgrade {
  /** Destroys BOTH sockets — the browser's and the daemon's. Idempotent. */
  close(): void;
}

/**
 * Proxies a WebSocket upgrade to the daemon. The daemon authenticates a
 * socket handshake from a `token` QUERY PARAM (a browser cannot set a header
 * on a WebSocket handshake), so rewriting the URL is the whole of the auth
 * story here — no frame ever needs to be inspected or rewritten.
 */
export function proxyUpgrade(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  handle: DaemonHandle,
): ProxiedUpgrade {
  const requestUrl = new URL(req.url ?? '/', 'http://internal');
  // Replaced outright, not merged: whatever token the phone's own URL
  // carried (there should be none) is not one the daemon should ever see.
  requestUrl.searchParams.set('token', handle.token);

  const upstream = netConnect({ host: handle.host, port: handle.port });

  let torn = false;
  const teardown = (): void => {
    if (torn) {
      return;
    }
    torn = true;
    // A pair torn down before the daemon answered (a stop, a revoke) must not
    // leave its connect timer holding the event loop for the rest of it.
    clearTimeout(connectTimeout);
    socket.destroy();
    upstream.destroy();
  };
  // `pipe()` forwards a source's `end` onto the destination's WRITABLE side
  // alone — it does not destroy the source, and a socket does not emit
  // `close` until both its own directions are done. With two sockets each
  // piped INTO the other, neither one's `close` ever fires by itself: each
  // is still open in the direction fed by the OTHER socket, which is
  // exactly a half-open leak. So `end`, not only `close`/`error`, tears the
  // whole pair down — the moment either side is done in either direction is
  // the moment neither socket has anything further to do.
  socket.on('error', teardown);
  socket.on('close', teardown);
  socket.on('end', teardown);
  upstream.on('error', teardown);
  upstream.on('close', teardown);
  upstream.on('end', teardown);

  const connectTimeout = setTimeout(teardown, DAEMON_CONNECT_TIMEOUT_MS);

  upstream.once('connect', () => {
    clearTimeout(connectTimeout);

    const headerLines: string[] = [
      `${req.method ?? 'GET'} ${requestUrl.pathname}${requestUrl.search} HTTP/1.1`,
    ];
    // Same strip as `proxyHttp` above, through the SAME helper — the strip
    // set is a security boundary, and a second hand-rolled copy here is how
    // a header added to one silently stops applying on the `/ws` upgrade.
    for (const [key, value] of Object.entries(
      forwardableHeaders(req.headers),
    )) {
      const values = Array.isArray(value) ? value : [value];
      for (const one of values) {
        headerLines.push(`${key}: ${one}`);
      }
    }
    headerLines.push(`Host: ${handle.host}:${handle.port}`);
    headerLines.push(`${REMOTE_VIA_HEADER}: ${REMOTE_VIA_VALUE}`);
    upstream.write(`${headerLines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  return { close: teardown };
}
