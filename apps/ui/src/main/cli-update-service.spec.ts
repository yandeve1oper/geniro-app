import { describe, expect, it, vi } from 'vitest';

import type { CliKind, CliUpdateResult, CliUpdates } from '../shared/contracts';
import { createCliUpdateService } from './cli-update-service';

function okResult(kind: CliKind, version: string): CliUpdateResult {
  return {
    kind,
    ok: true,
    previousVersion: '1.0.0',
    version,
    output: null,
    reason: null,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createCliUpdateService', () => {
  it('reports a CLI as updating from the press until its updater settles, through broadcast', async () => {
    const run = deferred<CliUpdateResult>();
    const pushed: CliUpdates[] = [];
    const service = createCliUpdateService({
      run: () => run.promise,
      broadcast: (state) => pushed.push(state),
    });

    const pending = service.update('codex');

    expect(service.getState()).toEqual({ updating: ['codex'], results: {} });
    expect(pushed.at(-1)).toEqual({ updating: ['codex'], results: {} });

    run.resolve(okResult('codex', '1.1.0'));
    await pending;

    expect(service.getState()).toEqual({
      updating: [],
      results: { codex: okResult('codex', '1.1.0') },
    });
    expect(pushed.at(-1)).toEqual(service.getState());
  });

  it('joins a second press for the same CLI instead of starting a second updater', async () => {
    const run = deferred<CliUpdateResult>();
    const runner = vi.fn(() => run.promise);
    const service = createCliUpdateService({
      run: runner,
      broadcast: () => undefined,
    });

    const first = service.update('claude');
    const second = service.update('claude');
    run.resolve(okResult('claude', '2.0.0'));

    await expect(Promise.all([first, second])).resolves.toEqual([
      okResult('claude', '2.0.0'),
      okResult('claude', '2.0.0'),
    ]);
    await Promise.resolve();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('settles a runner that threw as a failed update, so the CLI never stays "updating"', async () => {
    const service = createCliUpdateService({
      run: () => Promise.reject(new Error('spawn EACCES')),
      broadcast: () => undefined,
    });

    await expect(service.update('cursor-agent')).resolves.toMatchObject({
      kind: 'cursor-agent',
      ok: false,
      reason: 'spawn EACCES',
    });
    expect(service.getState().updating).toEqual([]);
  });

  it('drops the previous outcome of the CLI being updated again, and every outcome on forget', async () => {
    const service = createCliUpdateService({
      run: (kind) => Promise.resolve(okResult(kind, '9.9.9')),
      broadcast: () => undefined,
    });
    await service.update('claude');
    await service.update('codex');
    const run = service.update('claude');

    expect(Object.keys(service.getState().results)).toEqual(['codex']);
    await run;

    expect(service.forgetResults()).toEqual({ updating: [], results: {} });
  });
});
