import { describe, expect, it } from 'vitest';

import {
  claudeDisallowedToolArgs,
  claudeMcpServerRule,
  claudeMcpServerSegment,
  claudeSwitchedOffServers,
  claudeToolCallMetric,
} from './claude-mcp-tool-name.utils';

describe('claudeMcpServerSegment — the CLI’s own normalizer', () => {
  // Each pair is a server name and the tool-name segment claude 2.1.284
  // printed for it in `system/init`.
  it.each([
    ['codegraph', 'codegraph'],
    ['plugin:playwright:playwright', 'plugin_playwright_playwright'],
    ['claude.ai Booking.com', 'claude_ai_Booking_com'],
    ['claude.ai Google Calendar', 'claude_ai_Google_Calendar'],
    ['my-server_2', 'my-server_2'],
  ])('%s → %s', (server, segment) => {
    expect(claudeMcpServerSegment(server)).toBe(segment);
  });

  it('collapses underscore runs only for an account connector', () => {
    expect(claudeMcpServerSegment('a  b')).toBe('a__b');
    expect(claudeMcpServerSegment('claude.ai  a..b ')).toBe('claude_ai_a_b');
  });
});

describe('claudeMcpServerRule', () => {
  it('is a server-level rule for an ordinary name', () => {
    expect(claudeMcpServerRule('plugin:playwright:playwright')).toBe(
      'mcp__plugin_playwright_playwright',
    );
  });

  it('wildcards the tool part when the segment itself holds `__`', () => {
    // `mcp__a__b` would read as tool `b` of server `a`.
    expect(claudeMcpServerRule('a  b')).toBe('mcp__a__b__*');
  });
});

describe('claudeDisallowedToolArgs', () => {
  it('withholds claude’s own Monitor and ListAgents even when nothing is switched off', () => {
    expect(claudeDisallowedToolArgs(undefined, null)).toEqual([
      '--disallowedTools',
      'Monitor',
      'ListAgents',
    ]);
    expect(claudeDisallowedToolArgs([], 'geniro-run')).toEqual([
      '--disallowedTools',
      'Monitor',
      'ListAgents',
    ]);
  });

  it('is ONE flag followed by every rule, de-duplicated', () => {
    expect(
      claudeDisallowedToolArgs(
        ['codegraph', 'claude.ai Gmail', 'codegraph'],
        null,
      ),
    ).toEqual([
      '--disallowedTools',
      'Monitor',
      'ListAgents',
      'mcp__codegraph',
      'mcp__claude_ai_Gmail',
    ]);
  });

  it('never withholds geniro’s own server', () => {
    expect(
      claudeDisallowedToolArgs(['geniro-abc', 'codegraph'], 'geniro-abc'),
    ).toEqual(['--disallowedTools', 'Monitor', 'ListAgents', 'mcp__codegraph']);
    expect(claudeDisallowedToolArgs(['geniro-abc'], 'geniro-abc')).toEqual([
      '--disallowedTools',
      'Monitor',
      'ListAgents',
    ]);
  });
});

describe('claudeSwitchedOffServers', () => {
  it('returns the names as the member lists them, de-duplicated, without empty ones', () => {
    expect(
      claudeSwitchedOffServers(
        ['codegraph', '', 'claude.ai Gmail', 'codegraph'],
        null,
      ),
    ).toEqual(['codegraph', 'claude.ai Gmail']);
  });

  it('never returns geniro’s own server, matched by its segment as the CLI names it', () => {
    expect(
      claudeSwitchedOffServers(['geniro-abc', 'codegraph'], 'geniro-abc'),
    ).toEqual(['codegraph']);
    expect(claudeSwitchedOffServers(['a..b'], 'a  b')).toEqual([]);
  });

  it('is empty when nothing is switched off', () => {
    expect(claudeSwitchedOffServers(undefined, null)).toEqual([]);
    expect(claudeSwitchedOffServers([], 'geniro-run')).toEqual([]);
  });
});

describe('claudeToolCallMetric', () => {
  it('reads the MCP server and tool off an mcp__ name, and counts any other name as itself', () => {
    expect(claudeToolCallMetric('mcp__codegraph__codegraph_explore')).toEqual({
      tool: 'codegraph_explore',
      server: 'codegraph',
    });
    expect(
      claudeToolCallMetric('mcp__claude_ai_Booking_com__accommodations_search'),
    ).toEqual({
      tool: 'accommodations_search',
      server: 'claude_ai_Booking_com',
    });
    expect(claudeToolCallMetric('Bash')).toEqual({
      tool: 'Bash',
      server: null,
    });
    expect(claudeToolCallMetric('mcp__broken')).toEqual({
      tool: 'mcp__broken',
      server: null,
    });
  });
});
