import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hostEndpointPath } from '../utils/host-endpoint';
import {
  HOST_TOOL_RESULT_TTL_MS,
  HostToolResultLedger,
  MAX_HOST_TOOL_RESULTS_PER_ENDPOINT,
} from './host-tool-result.ledger';

const PATH = hostEndpointPath('run-1', 'manager', null);
const ENDPOINT = {
  url: `http://127.0.0.1:4100${PATH}`,
  serverName: 'geniro-run1abcd',
};
const call = (tool: string, args: unknown) => ({
  server: ENDPOINT.serverName,
  tool,
  args,
});
const text = (value: string) => ({
  content: [{ type: 'text', text: value }],
});

describe('HostToolResultLedger', () => {
  let ledger: HostToolResultLedger;

  beforeEach(() => {
    ledger = new HostToolResultLedger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands a watched endpoint the result it was served', () => {
    ledger.watch(ENDPOINT);
    ledger.record(PATH, 'team_notes', { limit: 5 }, text('two notes'));

    expect(ledger.resultOf(ENDPOINT, call('team_notes', { limit: 5 }))).toEqual(
      text('two notes'),
    );
    expect(
      ledger.resultOf(ENDPOINT, call('team_notes', { limit: 5 })),
    ).toBeUndefined();
  });

  it('keeps nothing for an endpoint no process watches', () => {
    ledger.record(PATH, 'team_notes', {}, text('two notes'));
    ledger.watch(ENDPOINT);

    expect(ledger.resultOf(ENDPOINT, call('team_notes', {}))).toBeUndefined();
  });

  it('drops what it kept once the last watcher lets go', () => {
    const first = ledger.watch(ENDPOINT);
    const second = ledger.watch(ENDPOINT);
    ledger.record(PATH, 'team_notes', {}, text('a'));
    first();
    first();
    expect(ledger.resultOf(ENDPOINT, call('team_notes', {}))).toEqual(
      text('a'),
    );

    ledger.record(PATH, 'team_notes', {}, text('b'));
    second();
    ledger.record(PATH, 'team_notes', {}, text('c'));
    expect(ledger.resultOf(ENDPOINT, call('team_notes', {}))).toBeUndefined();
  });

  it('matches arguments whatever their key order, and no arguments as an empty object', () => {
    ledger.watch(ENDPOINT);
    ledger.record(PATH, 'memory_search', { query: 'q', limit: 5 }, text('m'));
    ledger.record(PATH, 'list_agent_threads', {}, text('threads'));

    expect(
      ledger.resultOf(
        ENDPOINT,
        call('memory_search', { limit: 5, query: 'q' }),
      ),
    ).toEqual(text('m'));
    expect(ledger.resultOf(ENDPOINT, call('list_agent_threads', null))).toEqual(
      text('threads'),
    );
  });

  it('never takes a result served for other arguments or another tool', () => {
    ledger.watch(ENDPOINT);
    ledger.record(PATH, 'memory_search', { query: 'a' }, text('a'));

    expect(
      ledger.resultOf(ENDPOINT, call('memory_search', { query: 'b' })),
    ).toBeUndefined();
    expect(
      ledger.resultOf(ENDPOINT, call('memory_read', { query: 'a' })),
    ).toBeUndefined();
  });

  it('answers nothing for a call made to another server', () => {
    ledger.watch(ENDPOINT);
    ledger.record(PATH, 'get_issue', { id: 'CI-1' }, text('issue'));

    expect(
      ledger.resultOf(ENDPOINT, {
        server: 'linear',
        tool: 'get_issue',
        args: { id: 'CI-1' },
      }),
    ).toBeUndefined();
    expect(
      ledger.resultOf(ENDPOINT, call('get_issue', { id: 'CI-1' })),
    ).toEqual(text('issue'));
  });

  it('keeps the results of each endpoint apart', () => {
    const calleePath = hostEndpointPath('run-1', 'manager', 'conv-2');
    const callee = { ...ENDPOINT, url: `http://127.0.0.1:4100${calleePath}` };
    ledger.watch(ENDPOINT);
    ledger.watch(callee);
    ledger.record(calleePath, 'team_notes', {}, text('callee'));

    expect(ledger.resultOf(ENDPOINT, call('team_notes', {}))).toBeUndefined();
    expect(ledger.resultOf(callee, call('team_notes', {}))).toEqual(
      text('callee'),
    );
  });

  it('hands identical calls their results in order when the results agree', () => {
    ledger.watch(ENDPOINT);
    ledger.record(PATH, 'team_notes', {}, text('same'));
    ledger.record(PATH, 'team_notes', {}, text('same'));

    expect(ledger.resultOf(ENDPOINT, call('team_notes', {}))).toEqual(
      text('same'),
    );
    expect(ledger.resultOf(ENDPOINT, call('team_notes', {}))).toEqual(
      text('same'),
    );
  });

  it('guesses nothing when identical calls were served different results', () => {
    ledger.watch(ENDPOINT);
    ledger.record(PATH, 'await_agent', { call_id: 'c1' }, text('pending'));
    ledger.record(PATH, 'await_agent', { call_id: 'c1' }, text('done'));

    expect(
      ledger.resultOf(ENDPOINT, call('await_agent', { call_id: 'c1' })),
    ).toBeUndefined();
    expect(
      ledger.resultOf(ENDPOINT, call('await_agent', { call_id: 'c1' })),
    ).toEqual(text('done'));
  });

  it('forgets a result its call never came back for', () => {
    vi.useFakeTimers();
    ledger.watch(ENDPOINT);
    ledger.record(PATH, 'team_notes', {}, text('late'));
    vi.advanceTimersByTime(HOST_TOOL_RESULT_TTL_MS + 1);

    expect(ledger.resultOf(ENDPOINT, call('team_notes', {}))).toBeUndefined();
  });

  it('drops the expired results of every endpoint whenever another is served', () => {
    vi.useFakeTimers();
    const otherPath = hostEndpointPath('run-2', 'manager', null);
    const other = { ...ENDPOINT, url: `http://127.0.0.1:4100${otherPath}` };
    ledger.watch(ENDPOINT);
    ledger.watch(other);
    ledger.record(PATH, 'team_notes', {}, text('stale'));
    vi.advanceTimersByTime(HOST_TOOL_RESULT_TTL_MS + 1);
    ledger.record(otherPath, 'team_notes', {}, text('fresh'));

    expect(
      (ledger as unknown as { served: Map<string, unknown> }).served.has(PATH),
    ).toBe(false);
  });

  it('keeps at most the newest results of one endpoint', () => {
    ledger.watch(ENDPOINT);
    for (let i = 0; i <= MAX_HOST_TOOL_RESULTS_PER_ENDPOINT; i += 1) {
      ledger.record(PATH, 'memory_read', { id: i }, text(`m${i}`));
    }

    expect(
      ledger.resultOf(ENDPOINT, call('memory_read', { id: 0 })),
    ).toBeUndefined();
    expect(ledger.resultOf(ENDPOINT, call('memory_read', { id: 1 }))).toEqual(
      text('m1'),
    );
  });
});
