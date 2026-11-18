import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { probeCallEndpoint } from './call-endpoint-self-check';

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  count: number,
) => void;

interface SeenRequest {
  authorization: string | undefined;
  body: string;
}

let server: Server;
let port: number;
let handler: Handler;
let seen: SeenRequest[];
let connections: number;

const silent: Handler = () => undefined;

function answerOk(response: ServerResponse): void {
  response
    .writeHead(200, { 'content-type': 'application/json' })
    .end('{"jsonrpc":"2.0","id":0,"result":{}}');
}

function target(): { url: string; token: string } {
  return { url: `http://127.0.0.1:${port}/mcp`, token: 'call-token' };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      seen.push({ authorization: request.headers.authorization, body });
      handler(request, response, seen.length);
    });
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

beforeEach(() => {
  seen = [];
  connections = 0;
  handler = (_request, response) => answerOk(response);
});

afterEach(() => {
  server.closeAllConnections();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('probeCallEndpoint', () => {
  it('retries a timed-out attempt on the next budget and reports success when that one answers', async () => {
    handler = (_request, response, count) => {
      if (count > 1) {
        answerOk(response);
        return;
      }
      const late = setTimeout(() => answerOk(response), 3_000);
      response.on('close', () => clearTimeout(late));
    };

    await expect(probeCallEndpoint(target(), [300, 5_000])).resolves.toBeNull();
  });

  it('reports a non-ok answer at once, without a retry', async () => {
    handler = (_request, response) => {
      response.writeHead(500).end();
    };

    await expect(probeCallEndpoint(target())).resolves.toBe('HTTP 500');
    expect(seen).toHaveLength(1);
  });

  it('reports a refused connection with its error at once, without waiting out a budget', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, '127.0.0.1', resolve),
    );
    const freePort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    await expect(
      probeCallEndpoint(
        { url: `http://127.0.0.1:${freePort}/mcp`, token: 'call-token' },
        [5_000, 5_000],
      ),
    ).resolves.toBe(`connect ECONNREFUSED 127.0.0.1:${freePort}`);
  });

  it('opens a connection of its own for every probe, never a pooled keep-alive one', async () => {
    await expect(probeCallEndpoint(target())).resolves.toBeNull();
    await expect(probeCallEndpoint(target())).resolves.toBeNull();
    expect(seen).toHaveLength(2);
    expect(connections).toBe(2);
  });

  it('gives up after every budget has timed out and names the attempt count', async () => {
    handler = silent;

    const failure = await probeCallEndpoint(target(), [200, 400]);

    expect(failure).toMatch(/^timed out after 2 attempts/);
  });

  it('sends the bearer token and an initialize request, and reports nothing on success', async () => {
    await expect(probeCallEndpoint(target())).resolves.toBeNull();

    expect(seen).toHaveLength(1);
    const [first] = seen;
    expect(first?.authorization).toBe('Bearer call-token');
    expect(JSON.parse(first?.body ?? '{}')).toMatchObject({
      method: 'initialize',
    });
  });
});
