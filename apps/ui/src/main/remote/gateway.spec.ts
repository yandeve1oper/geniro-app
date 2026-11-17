import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { IpcRegistry } from '../ipc-registry';
import { DeviceRegistry } from './device-registry';
import { type GatewayOptions, RemoteGateway } from './gateway';
import { Pairing } from './pairing';

const ALLOWED_HOST_NAME = 'my-gateway-test-host';

interface RawResponse {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

/** A raw HTTP request whose Host header is set exactly as given, not derived from the connection target. */
function rawRequest(
  port: number,
  options: {
    path: string;
    method?: string;
    host?: string;
    acceptEncoding?: string;
  },
): Promise<RawResponse & { bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: {
          ...(options.host !== undefined ? { host: options.host } : {}),
          ...(options.acceptEncoding !== undefined
            ? { 'accept-encoding': options.acceptEncoding }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            body: bytes.toString('utf8'),
            bytes,
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A raw upgrade request over a socket this test owns, so a refused upgrade (no response, socket closed) is directly observable. */
function rawUpgrade(
  port: number,
  host: string,
): Promise<{ gotResponse: boolean; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.write(
        [
          'GET /ws HTTP/1.1',
          `Host: ${host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          '',
          '',
        ].join('\r\n'),
      );
    });
    let gotResponse = false;
    socket.on('data', () => {
      gotResponse = true;
    });
    socket.on('close', () => resolve({ gotResponse, closed: true }));
    socket.on('error', reject);
    // Guards the test itself against a genuine hang — if the guard were
    // reverted, the socket would sit open waiting for a proxied response
    // that never arrives from an absent daemon.
    setTimeout(() => {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }, 2_000);
  });
}

function listenOnAnyPort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => res.end('occupied'));
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected a bound port');
      }
      resolve({ server, port: address.port });
    });
  });
}

function makeGatewayOptions(
  staticRoot: string,
  overrides: Partial<GatewayOptions> = {},
): GatewayOptions {
  const dir = mkdtempSync(join(tmpdir(), 'geniro-gateway-registry-'));
  return {
    pairing: new Pairing(),
    deviceRegistry: new DeviceRegistry({
      filePath: join(dir, 'remote-devices.json'),
    }),
    ipcRegistry: new IpcRegistry(),
    daemonHandle: () => null,
    staticRoot,
    preferredPort: 0,
    allowedHostNames: [ALLOWED_HOST_NAME],
    ...overrides,
  };
}

const gateways: RemoteGateway[] = [];
const plainServers: Server[] = [];
/**
 * Upgraded sockets on a FAKE daemon's side. Its own `close()` waits on them
 * exactly as the gateway's did, so they are destroyed before it is closed.
 */
const daemonSockets: Socket[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  for (const socket of daemonSockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(
    plainServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe('RemoteGateway: host guard', () => {
  it('refuses a foreign Host on an ordinary request with 403', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>ok</html>');
    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    const response = await rawRequest(port, {
      path: '/',
      host: 'evil.example.com',
    });

    expect(response.status).toBe(403);
  });

  it('refuses a foreign Host on the WebSocket upgrade path — no response, socket closed', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    const result = await rawUpgrade(port, 'evil.example.com');

    // A refused upgrade never gets a 101 (or any other HTTP response) at
    // all — the guard destroys the raw socket before Node's own HTTP
    // upgrade machinery has anything to answer with.
    expect(result.gotResponse).toBe(false);
    expect(result.closed).toBe(true);
  });

  // `extraAllowedHosts` is how an OPEN tunnel widens the guard. It has to
  // reach BOTH arms: a phone on the public address that could list chats and
  // never watch one is the exact shape of a bug this directory has already
  // shipped once, on the upgrade path.
  it('admits a tunnel’s host pattern on an ordinary request', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>ok</html>');
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        extraAllowedHosts: () => ['*.trycloudflare.com'],
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    const response = await rawRequest(port, {
      path: '/',
      host: 'keyword-portsmouth.trycloudflare.com',
    });

    expect(response.status).not.toBe(403);
  });

  it('admits a tunnel’s host pattern on the WebSocket upgrade path too', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        extraAllowedHosts: () => ['*.trycloudflare.com'],
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    const result = await rawUpgrade(port, 'abc.trycloudflare.com');

    // It gets PAST the host guard — the pairing gate below it still refuses
    // this unpaired socket, which is why the assertion is about the guard
    // rather than about a 101.
    expect(result.closed).toBe(true);
  });

  it('stops admitting the pattern the moment the tunnel closes', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>ok</html>');
    let open = true;
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        extraAllowedHosts: () => (open ? ['*.trycloudflare.com'] : []),
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }
    const host = 'abc.trycloudflare.com';
    expect((await rawRequest(port, { path: '/', host })).status).not.toBe(403);

    open = false;

    // Read FRESH per request, which is the whole reason the option is a
    // function: a mask captured at construction would admit the provider's
    // zone for the rest of the launch, with no tunnel behind it.
    expect((await rawRequest(port, { path: '/', host })).status).toBe(403);
  });

  it('accepts a request whose Host is in the allowed list (sanity: the guard is not refusing everything)', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>ok</html>');
    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    const response = await rawRequest(port, {
      path: '/',
      host: `${ALLOWED_HOST_NAME}:${port}`,
    });

    expect(response.status).not.toBe(403);
  });
});

describe('RemoteGateway: static serving', () => {
  it('refuses a request that would resolve outside the static root, segment-wise', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>ok</html>');
    // A SIBLING directory whose name merely begins with the root's — the
    // exact case a bare `startsWith(root)` would wrongly admit.
    const siblingDir = `${staticRoot}-evil`;
    mkdirSync(siblingDir);
    writeFileSync(join(siblingDir, 'secret.txt'), 'top secret');

    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    // `%2F` survives the WHATWG URL parser unmolested (it is not treated as
    // a path separator during dot-segment normalization), so this is the
    // shape of request whose traversal only appears after this module's
    // OWN `decodeURIComponent` — which is exactly why the containment
    // check has to run AFTER decoding, not merely trust `url.pathname`.
    const response = await rawRequest(port, {
      path:
        '/..%2F' +
        encodeURIComponent(siblingDir.split('/').pop() ?? '') +
        '/secret.txt',
      host: `${ALLOWED_HOST_NAME}:${port}`,
    });

    expect(response.status).toBe(403);
    expect(response.body).not.toContain('top secret');
  });

  it('serves a real file inside the root (sanity: the guard is not refusing legitimate paths)', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(
      join(staticRoot, 'index.html'),
      '<html>hello from root</html>',
    );

    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    const response = await rawRequest(port, {
      path: '/',
      host: `${ALLOWED_HOST_NAME}:${port}`,
    });

    expect(response.status).toBe(200);
    expect(response.body).toContain('hello from root');
  });

  // The Graphs page on a phone read "Importing a module script failed.": its
  // tab had outlived an update, asked for the OLD build's lazy chunk, and got
  // the page back at 200 as text/html — which WebKit will not run as a module.
  it('answers a missing chunk with 404, never with the page', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>page</html>');
    mkdirSync(join(staticRoot, 'assets'));

    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }
    const host = `${ALLOWED_HOST_NAME}:${port}`;

    const chunk = await rawRequest(port, {
      path: '/assets/Teams-OLDHASH.js',
      host,
    });
    const file = await rawRequest(port, { path: '/favicon.ico', host });

    expect(chunk.status).toBe(404);
    expect(chunk.body).not.toContain('<html>');
    expect(chunk.headers['cache-control']).toBe('no-store');
    expect(file.status).toBe(404);
  });

  it('still answers a navigation with the page', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>page</html>');

    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    const response = await rawRequest(port, {
      path: '/some/screen',
      host: `${ALLOWED_HOST_NAME}:${port}`,
    });

    expect(response.status).toBe(200);
    expect(response.body).toContain('<html>page</html>');
  });

  it('never lets the page be stored, and keeps content-hashed chunks for good', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>page</html>');
    mkdirSync(join(staticRoot, 'assets'));
    writeFileSync(join(staticRoot, 'assets', 'App-abc123.js'), 'export {};');
    writeFileSync(join(staticRoot, 'icon.png'), 'png');

    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }
    const host = `${ALLOWED_HOST_NAME}:${port}`;

    const page = await rawRequest(port, { path: '/', host });
    const fallback = await rawRequest(port, { path: '/some/screen', host });
    const chunk = await rawRequest(port, {
      path: '/assets/App-abc123.js',
      host,
    });
    const icon = await rawRequest(port, { path: '/icon.png', host });

    // A stored page is how a reload or a restored tab comes back naming the
    // chunks of a build the gateway no longer has.
    expect(page.headers['cache-control']).toBe('no-store');
    expect(fallback.headers['cache-control']).toBe('no-store');
    expect(chunk.status).toBe(200);
    expect(chunk.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(icon.headers['cache-control']).toBe('no-cache');
  });

  it('compresses a text file for a client that accepts it, brotli over gzip, and leaves a picture alone', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>page</html>');
    mkdirSync(join(staticRoot, 'assets'));
    const script = `export const rows = ${JSON.stringify(
      Array.from({ length: 400 }, (_, i) => ({ id: i, text: 'a row' })),
    )};`;
    writeFileSync(join(staticRoot, 'assets', 'App-abc123.js'), script);
    const picture = Buffer.alloc(4096, 7);
    writeFileSync(join(staticRoot, 'icon.png'), picture);

    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }
    const host = `${ALLOWED_HOST_NAME}:${port}`;
    const path = '/assets/App-abc123.js';

    const lan = await rawRequest(port, {
      path,
      host,
      acceptEncoding: 'gzip, deflate',
    });
    const tunnel = await rawRequest(port, {
      path,
      host,
      acceptEncoding: 'gzip, deflate, br',
    });
    const plain = await rawRequest(port, { path, host });
    const icon = await rawRequest(port, {
      path: '/icon.png',
      host,
      acceptEncoding: 'gzip, br',
    });

    expect(lan.headers['content-encoding']).toBe('gzip');
    expect(lan.headers['content-length']).toBeUndefined();
    expect(lan.headers.vary).toBe('Accept-Encoding');
    expect(lan.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(lan.bytes.length).toBeLessThan(script.length / 4);
    expect(gunzipSync(lan.bytes).toString('utf8')).toBe(script);
    expect(tunnel.headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(tunnel.bytes).toString('utf8')).toBe(script);
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.headers['content-length']).toBe(String(script.length));
    expect(plain.body).toBe(script);
    expect(icon.headers['content-encoding']).toBeUndefined();
    expect(icon.bytes.equals(picture)).toBe(true);
  });

  it('cuts the answer when a file cannot be read after its headers went out, compressed or not', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>page</html>');
    mkdirSync(join(staticRoot, 'assets'));
    const locked = join(staticRoot, 'assets', 'App-locked.js');
    writeFileSync(locked, 'export {};'.repeat(500));
    chmodSync(locked, 0o000);

    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }
    const read = (acceptEncoding?: string) =>
      new Promise<string>((resolve) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: '/assets/App-locked.js',
            headers: {
              host: `${ALLOWED_HOST_NAME}:${port}`,
              ...(acceptEncoding === undefined
                ? {}
                : { 'accept-encoding': acceptEncoding }),
            },
          },
          (res) => {
            res.on('data', () => undefined);
            res.on('end', () => resolve('ended'));
            res.on('error', () => resolve('cut'));
            res.on('aborted', () => resolve('cut'));
          },
        );
        req.on('error', () => resolve('cut'));
        req.end();
        setTimeout(() => resolve('hung'), 3_000);
      });

    try {
      expect(await read()).toBe('cut');
      expect(await read('gzip')).toBe('cut');
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  it('never serves a .map file', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>ok</html>');
    writeFileSync(join(staticRoot, 'app.js.map'), '{"version":3}');

    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    const response = await rawRequest(port, {
      path: '/app.js.map',
      host: `${ALLOWED_HOST_NAME}:${port}`,
    });

    expect(response.status).toBe(404);
  });
});

describe('RemoteGateway: port fallback', () => {
  it('falls back to a free port when the preferred one is already in use', async () => {
    const { server: conflictServer, port: conflictPort } =
      await listenOnAnyPort();
    plainServers.push(conflictServer);

    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, { preferredPort: conflictPort }),
    );
    gateways.push(gateway);

    await gateway.start();

    const boundPort = gateway.port();
    expect(boundPort).not.toBeNull();
    expect(boundPort).not.toBe(conflictPort);
  });
});

describe('RemoteGateway: the pairing gate on the proxied surfaces', () => {
  /** A raw request that also carries a Cookie (and optionally an Origin) header, which `rawRequest` does not. */
  function requestWithCookie(
    port: number,
    options: { path: string; host: string; cookie?: string; origin?: string },
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { host: options.host };
      if (options.cookie !== undefined) {
        headers.cookie = options.cookie;
      }
      if (options.origin !== undefined) {
        headers.origin = options.origin;
      }
      const req = httpRequest(
        { host: '127.0.0.1', port, path: options.path, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              headers: res.headers,
            });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * The proxy injects the DAEMON's own bearer token, so an ungated arm hands
   * an unpaired stranger on the Wi-Fi the credential the daemon's guard
   * exists to demand — and `POST /v1/chats` starts an agent. This is the
   * finding the whole gate was added for: it guarded the bridge and the
   * event stream and left these two open.
   */
  it('refuses /v1 to a caller with no paired cookie, without reaching the daemon', async () => {
    let daemonSawRequest = false;
    const daemon = createServer((_req, res) => {
      daemonSawRequest = true;
      res.writeHead(200).end('{}');
    });
    plainServers.push(daemon);
    await new Promise<void>((resolve) =>
      daemon.listen(0, '127.0.0.1', resolve),
    );
    const daemonPort = (daemon.address() as { port: number }).port;

    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html></html>');
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        daemonHandle: () => ({
          host: '127.0.0.1',
          port: daemonPort,
          token: 'daemon-secret',
          version: '1.0.0',
          startedAt: new Date(0).toISOString(),
        }),
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port()!;

    const refused = await requestWithCookie(port, {
      path: '/v1/chats',
      host: `${ALLOWED_HOST_NAME}:${port}`,
    });

    expect(refused.status).toBe(401);
    // The point is not only the status: nothing must have been forwarded.
    expect(daemonSawRequest).toBe(false);
    expect(refused.body).not.toContain('daemon-secret');
  });

  it('refuses /v1 to a cookie no device holds', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html></html>');
    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port()!;

    const refused = await requestWithCookie(port, {
      path: '/v1/chats',
      host: `${ALLOWED_HOST_NAME}:${port}`,
      cookie: 'geniro_remote=not-a-real-session',
    });

    expect(refused.status).toBe(401);
  });

  it('lets a page’s own audio or video through without the paired cookie, and without the daemon’s token', async () => {
    const seen: { path: string; auth: string | undefined }[] = [];
    const daemon = createServer((req, res) => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization });
      res.writeHead(206, { 'content-type': 'video/mp4' });
      res.end('bytes');
    });
    plainServers.push(daemon);
    await new Promise<void>((resolve) =>
      daemon.listen(0, '127.0.0.1', resolve),
    );
    const daemonPort = (daemon.address() as { port: number }).port;
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html></html>');
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        daemonHandle: () => ({
          host: '127.0.0.1',
          port: daemonPort,
          token: 'daemon-secret',
          version: '1.0.0',
          startedAt: new Date(0).toISOString(),
        }),
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port()!;
    const media = `/v1/artifacts/11111111-2222-4333-8444-555555555555/tour/media/${'a'.repeat(64)}.mp4?key=${'b'.repeat(64)}`;

    const allowed = await requestWithCookie(port, {
      path: media,
      host: `${ALLOWED_HOST_NAME}:${port}`,
    });
    const page = await requestWithCookie(port, {
      path: `/v1/artifacts/11111111-2222-4333-8444-555555555555/tour?key=${'b'.repeat(64)}`,
      host: `${ALLOWED_HOST_NAME}:${port}`,
    });

    expect(allowed.status).toBe(206);
    expect(page.status).toBe(401);
    expect(seen).toEqual([{ path: media, auth: undefined }]);
  });

  it('lets a paired device through to the daemon', async () => {
    const daemon = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sawAuth: req.headers.authorization }));
    });
    plainServers.push(daemon);
    await new Promise<void>((resolve) =>
      daemon.listen(0, '127.0.0.1', resolve),
    );
    const daemonPort = (daemon.address() as { port: number }).port;

    const dir = mkdtempSync(join(tmpdir(), 'geniro-gateway-registry-'));
    const deviceRegistry = new DeviceRegistry({
      filePath: join(dir, 'remote-devices.json'),
    });
    deviceRegistry.add({ token: 'a-real-session', label: 'phone' });

    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html></html>');
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        deviceRegistry,
        daemonHandle: () => ({
          host: '127.0.0.1',
          port: daemonPort,
          token: 'daemon-secret',
          version: '1.0.0',
          startedAt: new Date(0).toISOString(),
        }),
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port()!;

    const allowed = await requestWithCookie(port, {
      path: '/v1/chats',
      host: `${ALLOWED_HOST_NAME}:${port}`,
      cookie: 'geniro_remote=a-real-session',
    });

    expect(allowed.status).toBe(200);
    // And the credential the daemon sees is the GATEWAY's to supply.
    expect(allowed.body).toContain('Bearer daemon-secret');
  });

  /** A paired gateway in front of a daemon that counts what reaches it. */
  async function pairedGatewayWithDaemon(
    overrides: Partial<GatewayOptions> = {},
  ): Promise<{ port: number; daemonRequests: () => number }> {
    let requests = 0;
    const daemon = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200).end('{}');
    });
    plainServers.push(daemon);
    await new Promise<void>((resolve) =>
      daemon.listen(0, '127.0.0.1', resolve),
    );
    const daemonPort = (daemon.address() as { port: number }).port;

    const dir = mkdtempSync(join(tmpdir(), 'geniro-gateway-registry-'));
    const deviceRegistry = new DeviceRegistry({
      filePath: join(dir, 'remote-devices.json'),
    });
    deviceRegistry.add({ token: 'origin-session', label: 'phone' });

    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html></html>');
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        deviceRegistry,
        daemonHandle: () => ({
          host: '127.0.0.1',
          port: daemonPort,
          token: 'daemon-secret',
          version: '1.0.0',
          startedAt: new Date(0).toISOString(),
        }),
        ...overrides,
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    return { port: gateway.port()!, daemonRequests: () => requests };
  }

  /**
   * The cookie's `SameSite` ignores PORTS, so a page served from another
   * port on this Mac's own LAN address is same-site and the browser attaches
   * the paired cookie to what it sends here. `/ws` refused such a page on its
   * Origin; `/v1` did not ask.
   */
  it('refuses /v1 from a foreign Origin even with a paired cookie, without reaching the daemon', async () => {
    const { port, daemonRequests } = await pairedGatewayWithDaemon();
    const host = `${ALLOWED_HOST_NAME}:${port}`;

    for (const origin of [
      'http://evil.example.com',
      // Same host, another port: the same-site case the cookie cannot stop.
      `http://${ALLOWED_HOST_NAME}:8080`,
      // Same host on the scheme's DEFAULT port, which an Origin omits — a
      // server on port 80 of this Mac, not this listener.
      `http://${ALLOWED_HOST_NAME}`,
      'null',
    ]) {
      const refused = await requestWithCookie(port, {
        path: '/v1/chats',
        host,
        cookie: 'geniro_remote=origin-session',
        origin,
      });
      expect(refused.status, origin).toBe(403);
    }
    expect(daemonRequests()).toBe(0);
  });

  it('admits /v1 from the gateway’s own origin, from an open tunnel’s public origin, and with no Origin at all', async () => {
    const { port, daemonRequests } = await pairedGatewayWithDaemon({
      extraAllowedHosts: () => ['*.trycloudflare.com'],
    });
    const cookie = 'geniro_remote=origin-session';

    // The page's own same-origin POST names this gateway.
    const own = await requestWithCookie(port, {
      path: '/v1/chats',
      host: `${ALLOWED_HOST_NAME}:${port}`,
      cookie,
      origin: `http://${ALLOWED_HOST_NAME}:${port}`,
    });
    // Down a tunnel both Host and Origin carry the public name, on 443.
    const tunnel = await requestWithCookie(port, {
      path: '/v1/chats',
      host: 'abc.trycloudflare.com',
      cookie,
      origin: 'https://abc.trycloudflare.com',
    });
    // A same-origin GET sends no Origin, which is every read the page makes.
    const none = await requestWithCookie(port, {
      path: '/v1/chats',
      host: `${ALLOWED_HOST_NAME}:${port}`,
      cookie,
    });

    expect([own.status, tunnel.status, none.status]).toEqual([200, 200, 200]);
    expect(daemonRequests()).toBe(3);
  });

  it('refuses a /ws upgrade from a foreign Origin and admits the gateway’s own', async () => {
    let daemonConnections = 0;
    const daemon = createServer();
    daemon.on('connection', () => {
      daemonConnections += 1;
    });
    plainServers.push(daemon);
    await new Promise<void>((resolve) =>
      daemon.listen(0, '127.0.0.1', resolve),
    );
    const daemonPort = (daemon.address() as { port: number }).port;

    const dir = mkdtempSync(join(tmpdir(), 'geniro-gateway-registry-'));
    const deviceRegistry = new DeviceRegistry({
      filePath: join(dir, 'remote-devices.json'),
    });
    deviceRegistry.add({ token: 'ws-origin-session', label: 'phone' });
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        deviceRegistry,
        daemonHandle: () => ({
          host: '127.0.0.1',
          port: daemonPort,
          token: 'daemon-secret',
          version: '1.0.0',
          startedAt: new Date(0).toISOString(),
        }),
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port()!;
    const host = `${ALLOWED_HOST_NAME}:${port}`;

    const upgrade = (origin: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const socket = netConnect(port, '127.0.0.1', () => {
          socket.write(
            [
              'GET /ws/?EIO=4&transport=websocket HTTP/1.1',
              `Host: ${host}`,
              `Origin: ${origin}`,
              'Cookie: geniro_remote=ws-origin-session',
              'Connection: Upgrade',
              'Upgrade: websocket',
              '',
              '',
            ].join('\r\n'),
          );
        });
        socket.on('error', reject);
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 250);
      });

    await upgrade(`http://${ALLOWED_HOST_NAME}`);
    expect(daemonConnections).toBe(0);

    await upgrade(`http://${ALLOWED_HOST_NAME}:${port}`);
    expect(daemonConnections).toBe(1);
  });

  it('refuses a /ws upgrade with no paired cookie', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html></html>');
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        daemonHandle: () => ({
          host: '127.0.0.1',
          port: 1,
          token: 'daemon-secret',
          version: '1.0.0',
          startedAt: new Date(0).toISOString(),
        }),
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port()!;

    const result = await rawUpgrade(port, `${ALLOWED_HOST_NAME}:${port}`);

    expect(result.gotResponse).toBe(false);
    expect(result.closed).toBe(true);
  });
});

describe('RemoteGateway: the /ws upgrade path shape', () => {
  /** An upgrade with an arbitrary path and cookie, unlike `rawUpgrade`'s fixed `/ws`. */
  function upgradeTo(
    port: number,
    options: { path: string; host: string; cookie?: string },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = netConnect(port, '127.0.0.1', () => {
        const lines = [
          `GET ${options.path} HTTP/1.1`,
          `Host: ${options.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
        ];
        if (options.cookie !== undefined) {
          lines.push(`Cookie: ${options.cookie}`);
        }
        socket.write([...lines, '', ''].join('\r\n'));
      });
      socket.on('error', reject);
      // The observable is whether the DAEMON was dialled, which settles
      // within a tick of the gateway's decision either way.
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 250);
    });
  }

  /**
   * engine.io asks for `/ws/?EIO=4&transport=websocket` and the daemon
   * answers only that form. Matching `'/ws'` EXACTLY dropped every real
   * handshake at the gateway while every unit test still passed: the phone
   * could list chats and start a run and never watch one. Driving a real
   * `ws` client is what found it; this is the observable that keeps it found
   * — whether the gateway dialled the daemon at all.
   */
  it('proxies the trailing-slash form engine.io actually requests', async () => {
    let daemonConnections = 0;
    const daemon = createServer();
    daemon.on('connection', () => {
      daemonConnections += 1;
    });
    plainServers.push(daemon);
    await new Promise<void>((resolve) =>
      daemon.listen(0, '127.0.0.1', resolve),
    );
    const daemonPort = (daemon.address() as { port: number }).port;

    const dir = mkdtempSync(join(tmpdir(), 'geniro-gateway-registry-'));
    const deviceRegistry = new DeviceRegistry({
      filePath: join(dir, 'remote-devices.json'),
    });
    deviceRegistry.add({ token: 'ws-session', label: 'phone' });

    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html></html>');
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        deviceRegistry,
        daemonHandle: () => ({
          host: '127.0.0.1',
          port: daemonPort,
          token: 'daemon-secret',
          version: '1.0.0',
          startedAt: new Date(0).toISOString(),
        }),
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port()!;
    const host = `${ALLOWED_HOST_NAME}:${port}`;

    await upgradeTo(port, {
      path: '/ws/?EIO=4&transport=websocket',
      host,
      cookie: 'geniro_remote=ws-session',
    });
    expect(daemonConnections).toBe(1);

    // The bare form still works — nothing about the fix narrows it.
    await upgradeTo(port, {
      path: '/ws',
      host,
      cookie: 'geniro_remote=ws-session',
    });
    expect(daemonConnections).toBe(2);

    // And a path that merely STARTS with the letters is still refused, so
    // the fix widened the match without opening it.
    await upgradeTo(port, {
      path: '/wsnot',
      host,
      cookie: 'geniro_remote=ws-session',
    });
    expect(daemonConnections).toBe(2);
  });
});

describe('RemoteGateway: a proxied /ws that stays open', () => {
  /**
   * A daemon that ANSWERS the upgrade and then holds the socket, the way the
   * real one holds a phone's live connection — unlike the fakes above, which
   * hang up and so never exercise a socket that outlives the handshake.
   */
  async function listenUpgradingDaemon(): Promise<number> {
    const daemon = createServer();
    daemon.on('upgrade', (_req, socket: Socket) => {
      daemonSockets.push(socket);
      socket.on('error', () => socket.destroy());
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
    });
    plainServers.push(daemon);
    await new Promise<void>((resolve) =>
      daemon.listen(0, '127.0.0.1', resolve),
    );
    return (daemon.address() as { port: number }).port;
  }

  /** Opens a `/ws` through the gateway and resolves once the daemon's 101 has come back through it. */
  function openSocket(
    port: number,
    cookie: string,
  ): Promise<{ socket: Socket; closed: Promise<void> }> {
    return new Promise((resolve, reject) => {
      const socket = netConnect(port, '127.0.0.1', () => {
        socket.write(
          [
            'GET /ws/?EIO=4&transport=websocket HTTP/1.1',
            `Host: ${ALLOWED_HOST_NAME}:${port}`,
            `Cookie: ${cookie}`,
            'Connection: Upgrade',
            'Upgrade: websocket',
            '',
            '',
          ].join('\r\n'),
        );
      });
      const closed = new Promise<void>((resolveClosed) =>
        socket.once('close', () => resolveClosed()),
      );
      socket.on('error', () => undefined);
      socket.once('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').startsWith('HTTP/1.1 101')) {
          resolve({ socket, closed });
          return;
        }
        reject(new Error(`expected a 101, got ${chunk.toString('utf8')}`));
      });
      void closed.then(() =>
        reject(new Error('closed before the upgrade completed')),
      );
    });
  }

  /** Whether `promise` settles within `ms` — the observable for "this did not hang". */
  function settlesWithin(
    promise: Promise<unknown>,
    ms: number,
  ): Promise<boolean> {
    return Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);
  }

  async function gatewayFor(
    deviceRegistry: DeviceRegistry,
    daemonPort: number,
  ): Promise<RemoteGateway> {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        deviceRegistry,
        daemonHandle: () => ({
          host: '127.0.0.1',
          port: daemonPort,
          token: 'daemon-secret',
          version: '1.0.0',
          startedAt: new Date(0).toISOString(),
        }),
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    return gateway;
  }

  function registry(): DeviceRegistry {
    const dir = mkdtempSync(join(tmpdir(), 'geniro-gateway-registry-'));
    return new DeviceRegistry({ filePath: join(dir, 'remote-devices.json') });
  }

  /**
   * `closeAllConnections()` does not reach a socket once it is upgraded, and
   * `close()` waits for it anyway — so one open phone tab made `stop()` never
   * settle. Switching remote access OFF awaited it (the IPC call hung, and so
   * did switching it back on), and `before-quit` awaited it too.
   */
  it('stop() settles while a proxied /ws is still open, and ends that socket', async () => {
    const daemonPort = await listenUpgradingDaemon();
    const devices = registry();
    devices.add({ token: 'phone-session', label: 'phone' });
    const gateway = await gatewayFor(devices, daemonPort);
    const phone = await openSocket(
      gateway.port()!,
      'geniro_remote=phone-session',
    );

    try {
      expect(await settlesWithin(gateway.stop(), 2_000)).toBe(true);
      expect(await settlesWithin(phone.closed, 1_000)).toBe(true);
      expect(gateway.port()).toBeNull();
    } finally {
      // Only matters when the assertions above fail: without it the hung
      // `stop()` would also hang this file's `afterEach`.
      phone.socket.destroy();
    }
  });

  /**
   * A socket is authorized once, at its handshake, so revoking a stolen
   * phone refused only what it asked for NEXT — its open tab kept a live,
   * token-bearing socket to the daemon.
   */
  it('disconnectDevice ends that device’s sockets and leaves another device’s open', async () => {
    const daemonPort = await listenUpgradingDaemon();
    const devices = registry();
    const stolen = devices.add({ token: 'stolen-session', label: 'stolen' });
    devices.add({ token: 'kept-session', label: 'kept' });
    const gateway = await gatewayFor(devices, daemonPort);
    const port = gateway.port()!;
    const stolenSocket = await openSocket(port, 'geniro_remote=stolen-session');
    const keptSocket = await openSocket(port, 'geniro_remote=kept-session');

    try {
      gateway.disconnectDevice(stolen.id);

      expect(await settlesWithin(stolenSocket.closed, 1_000)).toBe(true);
      expect(await settlesWithin(keptSocket.closed, 300)).toBe(false);
    } finally {
      stolenSocket.socket.destroy();
      keptSocket.socket.destroy();
    }
  });
});
