import { describe, expect, it } from 'vitest';

import {
  HOST_MEMORY_FEEDBACK_TOOL,
  HOST_MEMORY_TOOLS,
  HOST_SEARCH_CHATS_TOOL,
} from '../chat.types';
import { isHostMemoryCall } from './host-memory';

const SERVER = 'geniro-12345678';

describe('isHostMemoryCall', () => {
  it('matches each memory tool on geniro’s own server', () => {
    for (const tool of HOST_MEMORY_TOOLS) {
      expect(isHostMemoryCall(SERVER, `mcp__${SERVER}__${tool}`)).toBe(true);
    }
  });

  it('counts memory_feedback among the memory tools, matched by its wire name', () => {
    expect(HOST_MEMORY_TOOLS).toContain(HOST_MEMORY_FEEDBACK_TOOL);
    expect(
      isHostMemoryCall(SERVER, `mcp__${SERVER}__${HOST_MEMORY_FEEDBACK_TOOL}`),
    ).toBe(true);
  });

  it('matches no other tool, no other server, and nothing without a server', () => {
    expect(
      isHostMemoryCall(SERVER, `mcp__${SERVER}__${HOST_SEARCH_CHATS_TOOL}`),
    ).toBe(false);
    expect(
      isHostMemoryCall(SERVER, `mcp__geniro-87654321__${HOST_MEMORY_TOOLS[0]}`),
    ).toBe(false);
    expect(
      isHostMemoryCall(null, `mcp__${SERVER}__${HOST_MEMORY_TOOLS[0]}`),
    ).toBe(false);
  });
});
