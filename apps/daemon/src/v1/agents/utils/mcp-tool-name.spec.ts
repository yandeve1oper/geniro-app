import { describe, expect, it } from 'vitest';

import { bareToolName, mcpToolName } from './mcp-tool-name';

describe('bareToolName', () => {
  it('drops the server prefix an MCP tool call carries, and leaves any other name alone', () => {
    expect(bareToolName(mcpToolName('geniro-8a3e609a', 'message_thread'))).toBe(
      'message_thread',
    );
    expect(bareToolName('Bash')).toBe('Bash');
  });
});
