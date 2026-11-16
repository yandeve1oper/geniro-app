import { describe, expect, it, vi } from 'vitest';

import type {
  McpCallContext,
  McpListContext,
  McpTool,
  McpToolListing,
} from '../mcp.types';
import {
  gatedForHiddenLessons,
  HIDDEN_LESSONS_TOOLS,
} from './hidden-lessons-gate';

const CONTEXT: McpListContext = {
  runId: 'run-1',
  memberId: 'member-1',
  conversationId: null,
};

const OWN_NAMES = [
  'read_analyzed_thread',
  'memory_search',
  'memory_read',
  'memory_save',
  'propose_lessons',
  'check_lessons',
  'show_artifact',
  'browser_open',
];

const listing = (name: string): McpToolListing => ({
  name,
  description: `${name} description`,
  inputSchema: { type: 'object' },
});

function innerTool(): McpTool & { call: ReturnType<typeof vi.fn> } {
  return {
    handles: vi.fn((name: string) => OWN_NAMES.includes(name)),
    list: vi.fn(() => OWN_NAMES.map(listing)),
    call: vi.fn(async () => ({ content: [], isError: false })),
  };
}

const analysis = (hidden: boolean) => ({
  isHiddenLessons: vi.fn(() => hidden),
});

describe('gatedForHiddenLessons', () => {
  it('lists a hidden lessons chat only the five lessons tools', () => {
    const gated = gatedForHiddenLessons(innerTool(), analysis(true));

    expect(gated.list(CONTEXT).map((entry) => entry.name)).toEqual([
      'read_analyzed_thread',
      'memory_search',
      'memory_read',
      'propose_lessons',
      'check_lessons',
    ]);
  });

  it('keeps each listed entry whole, not just its name', () => {
    const gated = gatedForHiddenLessons(innerTool(), analysis(true));

    expect(gated.list(CONTEXT)[0]).toEqual(listing('read_analyzed_thread'));
  });

  it('names exactly those five tools in the allowed set', () => {
    expect([...HIDDEN_LESSONS_TOOLS].sort()).toEqual(
      [
        'check_lessons',
        'memory_read',
        'memory_search',
        'propose_lessons',
        'read_analyzed_thread',
      ].sort(),
    );
  });

  it('lists any other chat the tool’s own list unchanged', () => {
    const gated = gatedForHiddenLessons(innerTool(), analysis(false));

    expect(gated.list(CONTEXT)).toEqual(OWN_NAMES.map(listing));
  });

  it('asks the broker about the run and member being listed', () => {
    const broker = analysis(false);

    gatedForHiddenLessons(innerTool(), broker).list({
      ...CONTEXT,
      runId: 'run-9',
      memberId: 'member-9',
    });

    expect(broker.isHiddenLessons).toHaveBeenCalledWith('run-9', 'member-9');
  });

  it('answers handles and call through the wrapped tool, even for a hidden chat', async () => {
    const inner = innerTool();
    const gated = gatedForHiddenLessons(inner, analysis(true));
    const context = { ...CONTEXT } as McpCallContext;

    expect(gated.handles('memory_save')).toBe(true);
    expect(gated.handles('unknown_tool')).toBe(false);
    await gated.call('memory_save', { a: 1 }, context);
    expect(inner.call).toHaveBeenCalledWith('memory_save', { a: 1 }, context);
  });
});
