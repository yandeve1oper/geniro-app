import { Injectable } from '@nestjs/common';

import { hostEndpointKey } from '../utils/host-endpoint';
import { asRecord } from '../utils/json-util';

/** How long a served result waits for its CLI to settle the call it answered. */
export const HOST_TOOL_RESULT_TTL_MS = 2 * 60_000;

/** The most served results one endpoint keeps waiting at once. */
export const MAX_HOST_TOOL_RESULTS_PER_ENDPOINT = 16;

interface ServedResult {
  tool: string;
  args: string;
  result: unknown;
  servedAt: number;
}

/** The endpoint a turn was handed, as `AgentTurnInput.mcpEndpoint` names it. */
export interface HostEndpointRef {
  url: string;
  serverName: string;
}

/** One MCP call as a CLI reported it: the server, tool and arguments it named. */
export interface HostToolCallRef {
  server: string;
  tool: string;
  args: unknown;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = asRecord(value);
  if (record !== null) {
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function canonicalArgs(args: unknown): string {
  return args === null || args === undefined ? '{}' : canonicalJson(args);
}

/**
 * What geniro's own MCP endpoint answered, kept for a CLI that reports an MCP
 * call's outcome without its result (cursor), so the call's row can carry what
 * the tool really said.
 *
 * Results are kept only for an endpoint some process watches, and only briefly:
 * the CLI settles a call right after the response reaches it. A call is matched
 * by endpoint, tool and arguments; when the waiting results that match disagree
 * there is no telling which one this call got, so none is handed out.
 */
@Injectable()
export class HostToolResultLedger {
  private readonly watchers = new Map<string, number>();
  private readonly served = new Map<string, ServedResult[]>();

  watch(endpoint: HostEndpointRef): () => void {
    const key = hostEndpointKey(endpoint.url);
    if (key === null) {
      return () => {};
    }
    this.watchers.set(key, (this.watchers.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const left = (this.watchers.get(key) ?? 1) - 1;
      if (left > 0) {
        this.watchers.set(key, left);
        return;
      }
      this.watchers.delete(key);
      this.served.delete(key);
    };
  }

  record(
    endpointPath: string,
    tool: string,
    args: unknown,
    result: unknown,
  ): void {
    for (const key of [...this.served.keys()]) {
      this.fresh(key);
    }
    if (!this.watchers.has(endpointPath)) {
      return;
    }
    const waiting = this.fresh(endpointPath);
    waiting.push({
      tool,
      args: canonicalArgs(args),
      result,
      servedAt: Date.now(),
    });
    if (waiting.length > MAX_HOST_TOOL_RESULTS_PER_ENDPOINT) {
      waiting.shift();
    }
    this.served.set(endpointPath, waiting);
  }

  /**
   * The result geniro served for `call`, or undefined when the call was made to
   * another server, nothing matches, or the matching results disagree. The
   * oldest match is taken off either way, since this call is the one it waited
   * for.
   */
  resultOf(endpoint: HostEndpointRef, call: HostToolCallRef): unknown {
    if (call.server !== endpoint.serverName) {
      return undefined;
    }
    const key = hostEndpointKey(endpoint.url);
    if (key === null) {
      return undefined;
    }
    const waiting = this.fresh(key);
    const args = canonicalArgs(call.args);
    const matches = waiting.filter(
      (entry) => entry.tool === call.tool && entry.args === args,
    );
    const [oldest] = matches;
    if (oldest === undefined) {
      return undefined;
    }
    waiting.splice(waiting.indexOf(oldest), 1);
    if (matches.length === 1) {
      return oldest.result;
    }
    const body = canonicalJson(oldest.result);
    return matches.every((entry) => canonicalJson(entry.result) === body)
      ? oldest.result
      : undefined;
  }

  private fresh(key: string): ServedResult[] {
    const cutoff = Date.now() - HOST_TOOL_RESULT_TTL_MS;
    const waiting = (this.served.get(key) ?? []).filter(
      (entry) => entry.servedAt >= cutoff,
    );
    if (waiting.length === 0) {
      this.served.delete(key);
    } else {
      this.served.set(key, waiting);
    }
    return waiting;
  }
}
