import { describe, expect, it } from 'vitest';

import { hostEndpointKey, hostEndpointPath } from './host-endpoint';

describe('hostEndpointPath', () => {
  it('names a member in its own conversation by run and member', () => {
    expect(hostEndpointPath('run-1', 'manager', null)).toBe(
      '/v1/mcp/run-1/manager',
    );
  });

  it('adds the callee conversation a turn answers a call in', () => {
    expect(hostEndpointPath('run-1', 'qa', 'conv-7')).toBe(
      '/v1/mcp/run-1/qa/conv-7',
    );
  });

  it('escapes each segment, so an id cannot reach another endpoint', () => {
    expect(hostEndpointPath('run/1', 'a b', 'c?d')).toBe(
      '/v1/mcp/run%2F1/a%20b/c%3Fd',
    );
  });
});

describe('hostEndpointKey', () => {
  it('reads back the path of a URL built from hostEndpointPath', () => {
    const path = hostEndpointPath('run/1', 'a b', 'conv-7');
    expect(hostEndpointKey(`http://127.0.0.1:4100${path}`)).toBe(path);
  });

  it('answers null for a string that is no URL', () => {
    expect(hostEndpointKey('not a url')).toBeNull();
  });
});
