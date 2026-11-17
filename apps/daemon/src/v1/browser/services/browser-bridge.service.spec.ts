import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BROWSER_REQUEST_TIMEOUT_MS,
  type BrowserRequest,
} from '../browser.types';
import {
  BROWSER_CANCELLED_REASON,
  BROWSER_NO_WINDOW_REASON,
  BROWSER_TIMEOUT_REASON,
  BROWSER_WINDOW_DISCONNECTED_REASON,
  BrowserBridgeService,
} from './browser-bridge.service';

const draft: Omit<BrowserRequest, 'id'> = {
  runId: 'run-1',
  memberName: 'Dev',
  op: { kind: 'tabs' },
  allowedHosts: null,
};

function setup(): {
  bridge: BrowserBridgeService;
  emit: ReturnType<typeof vi.fn>;
  lastId: () => string;
} {
  const bridge = new BrowserBridgeService();
  const emit = vi.fn();
  bridge.attachEmitter(emit);
  return {
    bridge,
    emit,
    lastId: () => (emit.mock.calls.at(-1)?.[2] as BrowserRequest).id,
  };
}

describe('BrowserBridgeService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails at once when no window is registered', async () => {
    const { bridge, emit } = setup();

    await expect(bridge.request(draft)).resolves.toEqual({
      status: 'failed',
      reason: BROWSER_NO_WINDOW_REASON,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('fails at once without sending once the only window has disconnected', async () => {
    const { bridge, emit } = setup();
    bridge.register('mac');
    bridge.unregister('mac');

    await expect(bridge.request(draft)).resolves.toEqual({
      status: 'failed',
      reason: BROWSER_NO_WINDOW_REASON,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('sends the request to the registered socket only', async () => {
    const { bridge, emit, lastId } = setup();
    bridge.register('old');
    bridge.register('mac');

    const outcome = bridge.request(draft);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      'mac',
      'browser_request',
      expect.objectContaining({ ...draft, id: expect.any(String) }),
    );
    bridge.reply('mac', {
      id: lastId(),
      ok: true,
      text: 'done',
      png: 'AAAA',
      tab: 't1',
    });
    await expect(outcome).resolves.toEqual({
      status: 'done',
      text: 'done',
      png: 'AAAA',
      tab: 't1',
    });
  });

  it('turns a failed reply into a failed outcome', async () => {
    const { bridge, lastId } = setup();
    bridge.register('mac');
    const outcome = bridge.request(draft);

    bridge.reply('mac', { id: lastId(), ok: false, error: 'no such tab' });

    await expect(outcome).resolves.toEqual({
      status: 'failed',
      reason: 'no such tab',
    });
  });

  it('times out a request at 20 s', async () => {
    const { bridge } = setup();
    bridge.register('mac');
    const outcome = bridge.request(draft);

    await vi.advanceTimersByTimeAsync(BROWSER_REQUEST_TIMEOUT_MS - 1);
    const settled = vi.fn();
    void outcome.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toEqual({
      status: 'failed',
      reason: BROWSER_TIMEOUT_REASON,
    });
  });

  it('ignores a reply from another socket', async () => {
    const { bridge, lastId } = setup();
    bridge.register('mac');
    const outcome = bridge.request(draft);
    const id = lastId();
    const settled = vi.fn();
    void outcome.then(settled);

    bridge.reply('other', { id, ok: true, text: 'spoofed' });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    bridge.reply('mac', { id, ok: true, text: 'real' });
    await expect(outcome).resolves.toEqual({ status: 'done', text: 'real' });
  });

  it('ignores a malformed reply and an unknown id', async () => {
    const { bridge, lastId } = setup();
    bridge.register('mac');
    const outcome = bridge.request(draft);
    const id = lastId();
    const settled = vi.fn();
    void outcome.then(settled);

    bridge.reply('mac', { id, ok: true });
    bridge.reply('mac', { id: 'nope', ok: true, text: 'x' });
    bridge.reply('mac', 'garbage');
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    bridge.reply('mac', { id, ok: true, text: 'ok' });
    await expect(outcome).resolves.toMatchObject({ status: 'done' });
  });

  it('fails the pending requests of a socket that disconnects', async () => {
    const { bridge } = setup();
    bridge.register('mac');
    const outcome = bridge.request(draft);

    bridge.unregister('mac');

    await expect(outcome).resolves.toEqual({
      status: 'failed',
      reason: BROWSER_WINDOW_DISCONNECTED_REASON,
    });
    expect(bridge.hasHost()).toBe(false);
  });

  it('fails only the requests sent to the host that disconnects', async () => {
    const { bridge, lastId } = setup();
    bridge.register('mac');
    const toMac = bridge.request(draft);
    const macId = lastId();
    bridge.register('harness');
    const toHarness = bridge.request(draft);

    bridge.unregister('harness');

    await expect(toHarness).resolves.toEqual({
      status: 'failed',
      reason: BROWSER_WINDOW_DISCONNECTED_REASON,
    });
    bridge.reply('mac', { id: macId, ok: true, text: 'still here' });
    await expect(toMac).resolves.toEqual({
      status: 'done',
      text: 'still here',
    });
  });

  it('settles a request from the window it went to after a newer window took over', async () => {
    const { bridge, lastId } = setup();
    bridge.register('mac');
    const outcome = bridge.request(draft);
    const id = lastId();
    bridge.register('harness');

    bridge.reply('mac', { id, ok: true, text: 'answered' });

    await expect(outcome).resolves.toEqual({
      status: 'done',
      text: 'answered',
    });
  });

  it('ignores a reply from another registered window', async () => {
    const { bridge, lastId } = setup();
    bridge.register('mac');
    bridge.register('harness');
    const outcome = bridge.request(draft);
    const id = lastId();
    const settled = vi.fn();
    void outcome.then(settled);

    bridge.reply('mac', { id, ok: true, text: 'spoofed' });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    bridge.reply('harness', { id, ok: true, text: 'real' });
    await expect(outcome).resolves.toEqual({ status: 'done', text: 'real' });
  });

  it('gives the browser back to a window that registers again', () => {
    const { bridge, emit } = setup();
    bridge.register('mac');
    bridge.register('harness');
    bridge.register('mac');

    void bridge.request(draft);

    expect(emit.mock.calls.at(-1)?.[0]).toBe('mac');
    bridge.unregister('mac');
    void bridge.request(draft);
    expect(emit.mock.calls.at(-1)?.[0]).toBe('harness');
  });

  it('keeps the host and its requests when a replaced socket disconnects', async () => {
    const { bridge, lastId } = setup();
    bridge.register('old');
    bridge.register('mac');
    const outcome = bridge.request(draft);

    bridge.unregister('old');

    expect(bridge.hasHost()).toBe(true);
    bridge.reply('mac', { id: lastId(), ok: true, text: 'ok' });
    await expect(outcome).resolves.toMatchObject({ status: 'done' });
  });

  it('hands the browser back to a window still connected when the newer host disconnects', async () => {
    const { bridge, emit, lastId } = setup();
    bridge.register('mac');
    bridge.register('harness');

    bridge.unregister('harness');

    const outcome = bridge.request(draft);
    if (emit.mock.calls.length > 0) {
      bridge.reply('mac', { id: lastId(), ok: true, text: 'tabs' });
    }
    await expect(outcome).resolves.toEqual({ status: 'done', text: 'tabs' });
    expect(emit).toHaveBeenCalledWith(
      'mac',
      'browser_request',
      expect.objectContaining({ ...draft, id: expect.any(String) }),
    );
    expect(bridge.hasHost()).toBe(true);
  });

  it('rejects only the named run', async () => {
    const { bridge, lastId } = setup();
    bridge.register('mac');
    const first = bridge.request(draft);
    const second = bridge.request({ ...draft, runId: 'run-2' });
    const secondId = lastId();

    bridge.rejectRun('run-1', 'The chat was archived or deleted.');

    await expect(first).resolves.toEqual({
      status: 'failed',
      reason: 'The chat was archived or deleted.',
    });
    bridge.reply('mac', { id: secondId, ok: true, text: 'fine' });
    await expect(second).resolves.toEqual({ status: 'done', text: 'fine' });
  });

  it('cancels on abort', async () => {
    const { bridge, lastId } = setup();
    bridge.register('mac');
    const controller = new AbortController();
    const outcome = bridge.request(draft, controller.signal);
    const id = lastId();

    controller.abort();

    await expect(outcome).resolves.toEqual({
      status: 'failed',
      reason: BROWSER_CANCELLED_REASON,
    });
    bridge.reply('mac', { id, ok: true, text: 'late' });
  });

  it('fails without sending when the signal is already aborted', async () => {
    const { bridge, emit } = setup();
    bridge.register('mac');

    await expect(
      bridge.request(draft, AbortSignal.abort()),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(emit).not.toHaveBeenCalled();
  });
});
