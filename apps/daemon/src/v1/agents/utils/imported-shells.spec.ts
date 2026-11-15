import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../adapters/adapter.types';
import { closeImportedShells } from './imported-shells';

describe('closeImportedShells', () => {
  const open = (toolCallId: string | null, workId: string): AgentEvent => ({
    type: 'shell_open',
    toolCallId,
    workId,
  });

  it('closes each command still open, after everything else', () => {
    const events: AgentEvent[] = [
      open('c1', 'b1'),
      { type: 'text', text: 'started it' },
    ];
    expect(closeImportedShells(events)).toEqual([
      ...events,
      { type: 'shell_info', toolCallId: 'c1', workId: 'b1' },
    ]);
  });

  it('leaves a command alone that a close already named by its CALL', () => {
    const events: AgentEvent[] = [
      open('c1', 'b1'),
      { type: 'shell_info', toolCallId: 'c1', workId: 'other' },
    ];
    expect(closeImportedShells(events)).toBe(events);
  });

  it('hands back the very same list when nothing is open', () => {
    const events: AgentEvent[] = [{ type: 'text', text: 'hi' }];
    expect(closeImportedShells(events)).toBe(events);
  });
});
