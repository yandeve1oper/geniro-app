import { request } from 'node:http';

export const CALL_ENDPOINT_SELF_CHECK_BUDGETS_MS = [
  3_000, 10_000, 30_000,
] as const;

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'geniro-selfcheck', version: '0' },
  },
});

function isTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.cause instanceof DOMException &&
    err.cause.name === 'TimeoutError'
  );
}

function postInitialize(
  endpoint: { url: string; token: string },
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      endpoint.url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(INITIALIZE_BODY),
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${endpoint.token}`,
        },
        signal,
        agent: false,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(INITIALIZE_BODY);
  });
}

/**
 * JSON-RPC `initialize` against a run's MCP endpoint: null when it answers 2xx,
 * else why not. A timeout moves on to the next budget; any other failure is final.
 * Every attempt opens a connection of its own, as an agent's CLI does: a pooled
 * keep-alive socket the server has already closed would fail it.
 */
export async function probeCallEndpoint(
  endpoint: { url: string; token: string },
  budgetsMs: readonly number[] = CALL_ENDPOINT_SELF_CHECK_BUDGETS_MS,
): Promise<string | null> {
  for (const budget of budgetsMs) {
    try {
      const status = await postInitialize(
        endpoint,
        AbortSignal.timeout(budget),
      );
      return status >= 200 && status < 300 ? null : `HTTP ${status}`;
    } catch (err) {
      if (!isTimeout(err)) {
        return err instanceof Error ? err.message : String(err);
      }
    }
  }
  const seconds = Math.round(budgetsMs.reduce((sum, ms) => sum + ms, 0) / 1000);
  return `timed out after ${budgetsMs.length} attempts (${seconds}s)`;
}
