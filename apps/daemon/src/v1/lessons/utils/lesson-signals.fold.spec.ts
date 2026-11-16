import { describe, expect, it } from 'vitest';

import {
  foldLessonSignals,
  type LessonSignalItem,
} from './lesson-signals.fold';

function item(
  seq: number,
  kind: LessonSignalItem['kind'],
  payload: Record<string, unknown>,
  role: string | null = null,
): LessonSignalItem {
  return { seq, kind, role, payload: JSON.stringify(payload) };
}

describe('foldLessonSignals', () => {
  it('finds a user correction after the agent finished a turn', () => {
    const signals = foldLessonSignals([
      item(1, 'message', { text: 'run the tests' }, 'user'),
      item(2, 'message', { text: 'Done, all green.' }, 'assistant'),
      item(3, 'turn_complete', {}),
      item(
        4,
        'message',
        { text: 'No — only through pnpm --filter, plain vitest crashes' },
        'user',
      ),
    ]);

    expect(signals).toEqual([
      {
        kind: 'user_correction',
        seq: 4,
        excerpt: 'No — only through pnpm --filter, plain vitest crashes',
      },
    ]);
  });

  it('reads a Russian push-back as a correction', () => {
    const signals = foldLessonSignals([
      item(1, 'turn_complete', {}),
      item(2, 'message', { text: 'не запускай vitest напрямую' }, 'user'),
    ]);

    expect(signals.map((signal) => signal.kind)).toEqual(['user_correction']);
  });

  it('does not count a user message that only continues the work', () => {
    const signals = foldLessonSignals([
      item(1, 'turn_complete', {}),
      item(2, 'message', { text: 'great, now add the README section' }, 'user'),
    ]);

    expect(signals).toEqual([]);
  });

  it('does not count push-back that arrives before the agent finished anything', () => {
    const signals = foldLessonSignals([
      item(1, 'message', { text: 'no, start with the daemon' }, 'user'),
    ]);

    expect(signals).toEqual([]);
  });

  it('counts a correction that opens a stretch after a finished turn, when told the stretch follows one', () => {
    const items = [item(7, 'message', { text: 'No, that is wrong' }, 'user')];

    expect(foldLessonSignals(items)).toEqual([]);
    expect(foldLessonSignals(items, { afterFinishedTurn: true })).toEqual([
      { kind: 'user_correction', seq: 7, excerpt: 'No, that is wrong' },
    ]);
  });

  it('ignores a host-started turn, which is a system row, not a user message', () => {
    const signals = foldLessonSignals([
      item(1, 'turn_complete', {}),
      item(2, 'system', { text: 'no output for 5 minutes' }),
    ]);

    expect(signals).toEqual([]);
  });

  it('finds an error then success of the same tool, at the failure', () => {
    const signals = foldLessonSignals([
      item(1, 'tool_result', {
        name: 'Bash',
        isError: true,
        result: 'better-sqlite3 was compiled against a different Node.js',
      }),
      item(2, 'tool_result', { name: 'Read', isError: false, result: 'x' }),
      item(3, 'tool_result', { name: 'Bash', isError: false, result: 'ok' }),
    ]);

    expect(signals).toEqual([
      {
        kind: 'error_then_success',
        seq: 1,
        excerpt:
          'Bash: better-sqlite3 was compiled against a different Node.js',
      },
    ]);
  });

  it('does not count an error that never recovered', () => {
    const signals = foldLessonSignals([
      item(1, 'tool_result', { name: 'Bash', isError: true, result: 'boom' }),
      item(2, 'tool_result', { name: 'Read', isError: false, result: 'x' }),
    ]);

    expect(signals).toEqual([]);
  });

  it('finds a declined approval, a failed outcome, a reopened stage and review findings', () => {
    const signals = foldLessonSignals([
      item(1, 'approval_verdict', { id: 'a', allow: false }),
      item(2, 'approval_verdict', { id: 'b', allow: true }),
      item(3, 'thread_outcome', { kind: 'partial', summary: 'one PR open' }),
      item(4, 'thread_outcome', { kind: 'success', summary: 'merged' }),
      item(5, 'stage_change', {
        action: 'reopen',
        stageTitle: 'Build',
        text: 'tests failed',
      }),
      item(6, 'stage_change', { action: 'complete', stageTitle: 'Build' }),
      item(7, 'report_findings', { findings: [{}, {}] }),
    ]);

    expect(signals.map(({ kind, seq }) => ({ kind, seq }))).toEqual([
      { kind: 'approval_refused', seq: 1 },
      { kind: 'outcome_failed', seq: 3 },
      { kind: 'stage_reopened', seq: 5 },
      { kind: 'review_finding', seq: 7 },
    ]);
  });

  it('returns nothing for a clean segment and survives a payload that is not JSON', () => {
    const signals = foldLessonSignals([
      item(1, 'message', { text: 'add a button' }, 'user'),
      { seq: 2, kind: 'tool_result', role: null, payload: 'not json' },
      item(3, 'turn_complete', {}),
    ]);

    expect(signals).toEqual([]);
  });

  it('cuts a long excerpt to 200 characters', () => {
    const [signal] = foldLessonSignals([
      item(1, 'turn_complete', {}),
      item(2, 'message', { text: `no ${'x'.repeat(400)}` }, 'user'),
    ]);

    expect([...signal!.excerpt]).toHaveLength(200);
    expect(signal!.excerpt.endsWith('…')).toBe(true);
  });
});
