import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSecret } from '../../diagnostics/utils/redact';
import type { RunNoticeWriter } from './run-notice.writer';
import {
  WRITE_FAILURE_NOTICE_DELAY_MS,
  WriteFailureNotices,
} from './write-failure.notices';

describe('WriteFailureNotices', () => {
  let warn: ReturnType<typeof vi.fn>;
  let notices: WriteFailureNotices;

  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.fn(async () => undefined);
    notices = new WriteFailureNotices({ warn } as unknown as RunNoticeWriter);
  });

  afterEach(() => {
    notices.onApplicationShutdown();
    vi.useRealTimers();
  });

  it('writes one warning row for a burst of lost writes, naming how many and the first reason', async () => {
    notices.note('run-a', new Error('Expression tree is too large\nat insert'));
    notices.note('run-a', new Error('a later reason'));
    notices.note('run-a', new Error('a later reason'));
    expect(warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WRITE_FAILURE_NOTICE_DELAY_MS);

    expect(warn).toHaveBeenCalledTimes(1);
    const [runId, message, caption] = warn.mock.calls[0]!;
    expect(runId).toBe('run-a');
    expect(message).toMatch(/^3 events of this thread could not be saved/);
    expect(message).toMatch(/Reason: Expression tree is too large$/);
    expect(caption).toBe('Not saved');
  });

  it('keeps each run’s burst apart, and starts a new one after a row was written', async () => {
    notices.note('run-a', new Error('first'));
    notices.note('run-b', new Error('second'));
    await vi.advanceTimersByTimeAsync(WRITE_FAILURE_NOTICE_DELAY_MS);
    notices.note('run-a', new Error('again'));
    await vi.advanceTimersByTimeAsync(WRITE_FAILURE_NOTICE_DELAY_MS);

    expect(
      warn.mock.calls.map(([runId, message]) => [
        runId,
        /^1 event /.test(message),
      ]),
    ).toEqual([
      ['run-a', true],
      ['run-b', true],
      ['run-a', true],
    ]);
  });

  it('masks a registered secret in the reason it shows', async () => {
    registerSecret('tok-write-failure-secret', 'spec token');
    notices.note('run-a', new Error('rejected tok-write-failure-secret'));
    await vi.advanceTimersByTimeAsync(WRITE_FAILURE_NOTICE_DELAY_MS);

    expect(warn.mock.calls[0]![1]).not.toContain('tok-write-failure-secret');
  });
});
