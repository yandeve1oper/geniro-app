import { describe, expect, it } from 'vitest';

import {
  activityAfterAnnounce,
  displayRunStatus,
  isSettledRunStatus,
  isWorkingRunStatus,
  RUN_STATUS_META,
  type RunStatusKind,
} from './run-status';

describe('displayRunStatus', () => {
  it('reports a live turn as running even when the row still says completed', () => {
    // THE reported flicker. Three writers touch `run.status`, and a snapshot
    // refetch that lands after a fresher event re-asserts a stale `completed`
    // under an agent that is visibly still working. The live plane wins.
    expect(
      displayRunStatus({
        status: 'completed',
        streaming: true,
        awaitingAnswer: false,
      }),
    ).toBe('running');
  });

  it('does not invent liveness — a settled row with no live turn is reported as-is', () => {
    // The other half of the same promise: the override must be conditional on
    // `streaming`, not a blanket "always say running".
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      expect(
        displayRunStatus({ status, streaming: false, awaitingAnswer: false }),
      ).toBe(status);
    }
  });

  it('lets failed and cancelled through even mid-stream', () => {
    // Both are settle paths that can arrive before the live plane is torn
    // down. Painting a cancelled run as running would hide the outcome of the
    // thing the user just clicked Stop on.
    expect(
      displayRunStatus({
        status: 'cancelled',
        streaming: true,
        awaitingAnswer: false,
      }),
    ).toBe('cancelled');
    expect(
      displayRunStatus({
        status: 'failed',
        streaming: true,
        awaitingAnswer: false,
      }),
    ).toBe('failed');
  });

  it('reports a run whose sub-agent is still working as running, with nothing streaming', () => {
    // The requirement: while at least one background sub-agent is out, the
    // thread must read as in progress. `streaming` cannot carry it — the
    // daemon drops a delegate's deltas from the live tail, so a delegating
    // turn has nothing streaming while its delegates work, and the run fell
    // back to its stale `completed` row.
    expect(
      displayRunStatus({
        status: 'completed',
        streaming: false,
        awaitingAnswer: false,
        subagentRunning: true,
      }),
    ).toBe('running');
  });

  it('does not invent liveness from a sub-agent that has reported back', () => {
    // The other half: the override is conditional on a delegate actually being
    // in flight, not on the run ever having had one.
    expect(
      displayRunStatus({
        status: 'completed',
        streaming: false,
        awaitingAnswer: false,
        subagentRunning: false,
      }),
    ).toBe('completed');
  });

  it('lets failed and cancelled through even while a sub-agent is still out', () => {
    // A cancelled run is exactly where a delegate's last rows are still
    // landing, so the sub-agent signal earns no exception the live plane does
    // not get.
    for (const status of ['failed', 'cancelled'] as const) {
      expect(
        displayRunStatus({
          status,
          streaming: false,
          awaitingAnswer: false,
          subagentRunning: true,
        }),
      ).toBe(status);
    }
  });

  it('an open question still outranks a working sub-agent', () => {
    // Nothing advances until a human answers, delegates in flight or not.
    expect(
      displayRunStatus({
        status: 'running',
        streaming: true,
        awaitingAnswer: true,
        subagentRunning: true,
      }),
    ).toBe('needs-input');
  });

  it('an open question outranks every other signal', () => {
    // The turn IS still open at the daemon while a card waits, so `streaming`
    // and a `running` row both say "busy". Reporting that as running is what
    // left the user watching a spinner that was in fact waiting on them.
    expect(
      displayRunStatus({
        status: 'running',
        streaming: true,
        awaitingAnswer: true,
      }),
    ).toBe('needs-input');
    // Also from a row that has already gone terminal — a card outliving its
    // row's settle is precisely the "still asking, says completed" case.
    expect(
      displayRunStatus({
        status: 'completed',
        streaming: false,
        awaitingAnswer: true,
      }),
    ).toBe('needs-input');
  });

  it('stops calling a HELD turn running — the agent has finished talking', () => {
    // The reported "done but showing like it's working", second time around.
    // The sentence under the badge was fixed to say `waiting on 2 background
    // tasks`; the badge above it went on spinning `running`, because the live
    // plane is still open — holding it open is exactly what a hold IS, so
    // `streaming` cannot tell the two apart and something else has to.
    //
    // It bites hardest on a background task with no end (a dev server, a
    // tailed log): nothing settles it, so the turn stands until the daemon's
    // 30-minute silence deadline. The screenshot that came back read
    // `running · 20m 18s` under an answer finished twenty minutes earlier.
    //
    // The answer was `idle` for one release, and that word came straight back
    // reported: `i still see it seems like it finished but not`. `waiting` is
    // the same non-spinning, non-settled state under a badge that no longer
    // contradicts the `waiting on 1 sub-agent` line beneath it.
    expect(
      displayRunStatus({
        status: 'running',
        streaming: true,
        awaitingAnswer: false,
        heldForBackgroundWork: true,
      }),
    ).toBe('held');
  });

  it('reads a held run the SAME whether or not a delegate is producing rows', () => {
    // The reported "I see the chat is idle, and the moment I click on it that
    // changes to another status". `subagentRunning` is derived from the loaded
    // transcript, so it is knowable for the focused run alone — while it
    // outranked the hold, one run had two readings and the click swapped them
    // in front of the user.
    //
    // Pinning the two calls EQUAL rather than each against a literal is the
    // point: the defect was the difference, and a pair of separate literals
    // would go on passing if one of them drifted back.
    const held = {
      status: 'running',
      streaming: true,
      awaitingAnswer: false,
      heldForBackgroundWork: true,
    } as const;
    expect(displayRunStatus({ ...held, subagentRunning: true })).toBe(
      displayRunStatus({ ...held, subagentRunning: false }),
    );
    expect(displayRunStatus({ ...held, subagentRunning: true })).toBe('held');
  });

  it('still calls a delegate running when the turn is NOT held', () => {
    // What the ranking above must not cost: a delegating turn with nothing
    // streaming and no hold reads as its stale row — the reported "thread says
    // completed while sub-agents are visibly working" — so a live delegate has
    // to keep outranking the row itself.
    expect(
      displayRunStatus({
        status: 'completed',
        streaming: false,
        awaitingAnswer: false,
        subagentRunning: true,
        heldForBackgroundWork: false,
      }),
    ).toBe('running');
  });

  it('an open question outranks a hold, and a failure is not idle', () => {
    // Both directions of the ranking, since a hold sits in the middle of it.
    expect(
      displayRunStatus({
        status: 'running',
        streaming: true,
        awaitingAnswer: true,
        heldForBackgroundWork: true,
      }),
    ).toBe('needs-input');
    // A run that failed is failed, whatever it launched before it did.
    expect(
      displayRunStatus({
        status: 'failed',
        streaming: true,
        awaitingAnswer: false,
        heldForBackgroundWork: true,
      }),
    ).toBe('failed');
  });

  it('reads a team run whose leads ended their turns as completed', () => {
    expect(
      displayRunStatus({
        status: 'running',
        streaming: true,
        awaitingAnswer: false,
        subagentRunning: true,
        teamLeadsDone: true,
      }),
    ).toBe('completed');
    expect(
      displayRunStatus({
        status: 'running',
        streaming: true,
        awaitingAnswer: false,
        teamLeadsDone: false,
      }),
    ).toBe('running');
  });

  it('reads done team leads only over a running row', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      expect(
        displayRunStatus({
          status,
          streaming: false,
          awaitingAnswer: false,
          teamLeadsDone: true,
        }),
      ).toBe(status);
    }
    expect(
      displayRunStatus({
        status: 'running',
        streaming: false,
        awaitingAnswer: true,
        teamLeadsDone: true,
      }),
    ).toBe('needs-input');
  });

  it('leaves a held run UNSETTLED — its late rows still land', () => {
    // The reason the badge is `idle` and not `completed`: the turn is genuinely
    // still open, and everything downstream that asks "has this stopped for
    // good" must go on answering no. Reported as completed, a delegate's last
    // rows would arrive under a thread the app had already written off.
    expect(
      isSettledRunStatus(
        displayRunStatus({
          status: 'running',
          streaming: true,
          awaitingAnswer: false,
          heldForBackgroundWork: true,
        }),
      ),
    ).toBe(false);
  });
});

describe('RUN_STATUS_META', () => {
  it('gives needs-input its own non-spinning icon and a readable label', () => {
    // The status word is printed from `label`, so a slug would reach the
    // screen. And the icon must differ from `running`'s: the point of the
    // state is that it will NOT advance on its own, so a second spinner would
    // say the opposite of what it means.
    expect(RUN_STATUS_META['needs-input'].label).toBe('needs more info');
    expect(RUN_STATUS_META['needs-input'].icon).not.toBe(
      RUN_STATUS_META.running.icon,
    );
  });

  it('carries a label and a tone for every kind', () => {
    // The Record is exhaustive by type, but `label` was added later — this
    // catches a kind added with the tone filled in and the label forgotten,
    // which renders as an empty status word rather than a type error.
    const kinds: RunStatusKind[] = [
      'pending',
      'running',
      'held',
      'needs-input',
      'completed',
      'failed',
      'cancelled',
      'skipped',
    ];
    for (const kind of kinds) {
      expect(RUN_STATUS_META[kind].label, kind).toBeTruthy();
      expect(RUN_STATUS_META[kind].className, kind).toBeTruthy();
    }
  });
});

describe('isSettledRunStatus', () => {
  // Table-driven over EVERY kind, because both directions of getting this
  // wrong are user-visible and silent: widening it to `running` kills the
  // spinner on live work, and narrowing it restores the reported bug — a
  // completed chat with a tool row spinning forever.
  const settled: RunStatusKind[] = [
    'completed',
    'failed',
    'cancelled',
    'skipped',
  ];
  const unsettled: RunStatusKind[] = [
    'pending',
    'queued',
    'running',
    'held',
    'monitoring',
    'needs-input',
    'untracked',
  ];

  it('reports the four end states as settled', () => {
    for (const kind of settled) {
      expect(isSettledRunStatus(kind), kind).toBe(true);
    }
  });

  it('reports every state a run can still leave as unsettled', () => {
    // `needs-input` is the one worth naming: the turn is OPEN and waiting on a
    // human, so work genuinely is in flight and its spinners must keep
    // running. `waiting` is the other open turn — held while background work
    // it launched reports back. `pending` and `idle` are states a run has yet
    // to leave, not ones it has finished in.
    for (const kind of unsettled) {
      expect(isSettledRunStatus(kind), kind).toBe(false);
    }
  });

  it('covers every RunStatusKind between the two lists', () => {
    // Without this, a kind added later is silently absent from both lists and
    // the two cases above go on passing while saying nothing about it.
    expect([...settled, ...unsettled].sort()).toEqual(
      Object.keys(RUN_STATUS_META).sort(),
    );
  });
});

describe('a command still running after its turn', () => {
  const settled = {
    status: 'completed' as const,
    streaming: false,
    awaitingAnswer: false,
  };

  it('reads the run as HELD rather than completed', () => {
    // REPORTED against a thread reading `completed` beside a header counting
    // two running shells, with the agent's own last words being "the orphan
    // branch and the PR-body patch both wait on that".
    expect(displayRunStatus({ ...settled, shellsRunning: true })).toBe('held');
    expect(displayRunStatus({ ...settled, shellsRunning: false })).toBe(
      'completed',
    );
  });

  it('never resurrects a run the user stopped, or one that failed', () => {
    // Stop is final, and a failed run is failed — neither becomes "working"
    // because something it launched outlived it.
    for (const status of ['cancelled', 'failed'] as const) {
      expect(
        displayRunStatus({ ...settled, status, shellsRunning: true }),
      ).toBe(status);
    }
  });

  it('is outranked by everything the AGENT itself is doing', () => {
    // The weakest evidence here: a command outliving its turn says nothing
    // about the agent, so any reading about the agent wins.
    expect(
      displayRunStatus({
        ...settled,
        shellsRunning: true,
        awaitingAnswer: true,
      }),
    ).toBe('needs-input');
    expect(
      displayRunStatus({ ...settled, shellsRunning: true, streaming: true }),
    ).toBe('running');
    expect(
      displayRunStatus({
        ...settled,
        shellsRunning: true,
        subagentRunning: true,
      }),
    ).toBe('running');
  });

  it('leaves a run that never started alone', () => {
    // `pending` has no commands of its own to be waiting on, and neither does
    // a team node nothing ever ran.
    for (const status of ['pending', 'skipped'] as const) {
      expect(
        displayRunStatus({ ...settled, status, shellsRunning: true }),
      ).toBe(status);
    }
  });
});

describe('a background sub-agent still out', () => {
  const settled = {
    status: 'completed' as const,
    streaming: false,
    awaitingAnswer: false,
  };
  const held = {
    status: 'running' as const,
    streaming: true,
    awaitingAnswer: false,
    heldForBackgroundWork: true,
  };

  it('reads a turn held with a sub-agent out as running, not held', () => {
    expect(displayRunStatus({ ...held, subagentsOut: true })).toBe('running');
  });

  it('reads a settled row with a sub-agent out as running', () => {
    expect(displayRunStatus({ ...settled, subagentsOut: true })).toBe(
      'running',
    );
  });

  it('keeps a turn held for a background command reading held', () => {
    expect(displayRunStatus({ ...held, shellsRunning: true })).toBe('held');
  });

  it('an open question still outranks a sub-agent out', () => {
    expect(
      displayRunStatus({ ...held, awaitingAnswer: true, subagentsOut: true }),
    ).toBe('needs-input');
  });

  it('lets failed and cancelled through while a sub-agent is out', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      expect(
        displayRunStatus({ ...held, status, subagentsOut: true }),
        status,
      ).toBe(status);
      expect(
        displayRunStatus({ ...settled, status, subagentsOut: true }),
        status,
      ).toBe(status);
    }
  });
});

describe('a monitor still running after its turn', () => {
  const settled = {
    status: 'completed' as const,
    streaming: false,
    awaitingAnswer: false,
  };

  it('reads a finished run as waiting on it', () => {
    expect(displayRunStatus({ ...settled, monitorsRunning: true })).toBe(
      'monitoring',
    );
    expect(RUN_STATUS_META.monitoring.label).toBe('waiting');
    expect(displayRunStatus({ ...settled, monitorsRunning: false })).toBe(
      'completed',
    );
  });

  it('is outranked by the agent working, a question, and background work', () => {
    expect(
      displayRunStatus({ ...settled, monitorsRunning: true, streaming: true }),
    ).toBe('running');
    expect(
      displayRunStatus({
        ...settled,
        monitorsRunning: true,
        awaitingAnswer: true,
      }),
    ).toBe('needs-input');
    expect(
      displayRunStatus({
        ...settled,
        monitorsRunning: true,
        shellsRunning: true,
      }),
    ).toBe('held');
  });

  it('never resurrects a run that stopped, failed, or never started', () => {
    for (const status of ['cancelled', 'failed', 'pending'] as const) {
      expect(
        displayRunStatus({ ...settled, status, monitorsRunning: true }),
      ).toBe(status);
    }
  });

  it('is neither settled nor working', () => {
    expect(isSettledRunStatus('monitoring')).toBe(false);
    expect(isWorkingRunStatus('monitoring')).toBe(false);
  });
});

describe('activityAfterAnnounce', () => {
  it('leaves the phrase standing for an announce that names none', () => {
    expect(activityAfterAnnounce({ status: 'running' })).toBeUndefined();
    // A count-only announce carries no status and no phrase: it says nothing.
    expect(activityAfterAnnounce({ status: null })).toBeUndefined();
  });

  it('sets the phrase an announce names while the run runs', () => {
    expect(
      activityAfterAnnounce({ status: 'running', activity: 'running Bash' }),
    ).toBe('running Bash');
  });

  it('reads an empty or null phrase as naming nothing', () => {
    expect(
      activityAfterAnnounce({ status: 'running', activity: '' }),
    ).toBeNull();
    expect(
      activityAfterAnnounce({ status: 'running', activity: null }),
    ).toBeNull();
  });

  it('clears the phrase when the run stops, whatever the announce carried', () => {
    expect(activityAfterAnnounce({ status: 'completed' })).toBeNull();
    expect(
      activityAfterAnnounce({ status: 'completed', activity: 'running Bash' }),
    ).toBeNull();
  });
});
