import { describe, expect, it } from 'vitest';

import {
  isCommandCenterChat,
  isHostCommandCenterCall,
} from './host-command-center';

const SERVER = 'geniro-75a31aea';

describe('isHostCommandCenterCall', () => {
  it('matches tell_threads, note_thread and start_thread on this run’s server, in both spellings', () => {
    for (const tool of ['tell_threads', 'note_thread', 'start_thread']) {
      expect(isHostCommandCenterCall(SERVER, `mcp__${SERVER}__${tool}`)).toBe(
        true,
      );
      expect(
        isHostCommandCenterCall(SERVER, `${SERVER}-${tool}: ${tool}`),
      ).toBe(true);
    }
  });

  it('refuses message_thread, list_threads, another server and no server', () => {
    expect(
      isHostCommandCenterCall(SERVER, `mcp__${SERVER}__message_thread`),
    ).toBe(false);
    expect(
      isHostCommandCenterCall(SERVER, `mcp__${SERVER}__list_threads`),
    ).toBe(false);
    expect(isHostCommandCenterCall(SERVER, 'mcp__other__start_thread')).toBe(
      false,
    );
    expect(isHostCommandCenterCall(null, `mcp__${SERVER}__tell_threads`)).toBe(
      false,
    );
  });
});

describe('isCommandCenterChat', () => {
  it('is true only on a run marked as the manager', () => {
    expect(isCommandCenterChat({ commandCenter: true })).toBe(true);
    expect(isCommandCenterChat({ commandCenter: null })).toBe(false);
  });
});
