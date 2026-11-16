import { describe, expect, it } from 'vitest';

import type { AcpToolCall } from '../../acp/acp.types';
import { readCursorMcpToolCall } from './cursor-mcp-call.utils';

function call(name: string, rawInput: unknown): AcpToolCall {
  return {
    toolCallId: 't',
    name,
    status: null,
    kind: 'other',
    rawInput,
    rawOutput: null,
    locations: null,
  };
}

const WRAPPER = {
  providerIdentifier: 'geniro-83139c58',
  toolName: 'memory_search',
  args: { limit: 5, query: 'visibility' },
};

describe('readCursorMcpToolCall', () => {
  it('reads the server, tool and arguments under the session update’s title', () => {
    expect(
      readCursorMcpToolCall(call('geniro-83139c58: memory_search', WRAPPER)),
    ).toEqual({
      server: 'geniro-83139c58',
      tool: 'memory_search',
      args: { limit: 5, query: 'visibility' },
    });
  });

  it('reads them under the permission request’s title', () => {
    expect(
      readCursorMcpToolCall(
        call('geniro-83139c58-memory_search: memory_search', WRAPPER),
      ),
    ).toEqual(expect.objectContaining({ tool: 'memory_search' }));
  });

  it('answers null arguments for a wrapper that carries none', () => {
    expect(
      readCursorMcpToolCall(
        call('linear: list_teams', {
          providerIdentifier: 'linear',
          toolName: 'list_teams',
        }),
      ),
    ).toEqual({ server: 'linear', tool: 'list_teams', args: null });
  });

  it('refuses a title that is not built from the wrapper’s own server and tool', () => {
    expect(
      readCursorMcpToolCall(call('linear: get_issue', WRAPPER)),
    ).toBeNull();
    expect(
      readCursorMcpToolCall(
        call('`echo geniro-83139c58: memory_search`', WRAPPER),
      ),
    ).toBeNull();
  });

  it('refuses a call whose arguments are not the wrapper', () => {
    expect(readCursorMcpToolCall(call('MCP: tool', null))).toBeNull();
    expect(
      readCursorMcpToolCall(call('Read a file', { path: '/repo/a.ts' })),
    ).toBeNull();
  });
});
