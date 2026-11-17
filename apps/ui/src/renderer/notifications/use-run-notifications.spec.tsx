// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GeniroApi } from '../../shared/contracts';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import type { RunStatusKind } from '../chats/run-status';
import type { LessonsChangedEvent, SharesChangedEvent } from '../daemon-client';
import type { AgentNotice } from './run-notifications';
import {
  useLessonsFiledNotifications,
  useRunNotifications,
  useShareSignInNotifications,
} from './use-run-notifications';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  id: string;
  status: RunStatusKind;
  shellsOpen: number;
}

// Module scope, so the hook's effects re-run on the run list alone — the way
// `Chats` hands it memoized readers.
const statusOf = (run: Row): RunStatusKind => run.status;
const labelOf = (run: Row): string => run.id;
const awaitingOf = (): null => null;
const shellsOpenOf = (run: Row): number => run.shellsOpen;

function Probe({
  runs,
  notices,
}: {
  runs: readonly Row[];
  notices: readonly AgentNotice[];
}): null {
  useRunNotifications({
    runs,
    statusOf,
    labelOf,
    awaitingOf,
    shellsOpenOf,
    notices,
    activeRunId: null,
  });
  return null;
}

describe('useRunNotifications', () => {
  let container: HTMLDivElement;
  let root: Root;
  let notices: AgentNotice[];
  const notify = vi.fn<GeniroApi['notify']>(async () => {});
  const retractNotification = vi.fn<GeniroApi['retractNotification']>(
    async () => {},
  );

  beforeEach(() => {
    notify.mockClear();
    retractNotification.mockClear();
    notices = [];
    window.geniro = createPreloadStub({ notify, retractNotification });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /** One reading of the one run under test. */
  const show = (status: RunStatusKind, shellsOpen = 0): void => {
    act(() =>
      root.render(
        <Probe
          runs={[{ id: 'r1', status, shellsOpen }]}
          notices={[...notices]}
        />,
      ),
    );
  };

  /** The agent's `notify_user` call arriving, with the run as it stands. */
  const agentSays = (
    message: string,
    status: RunStatusKind,
    shellsOpen = 0,
  ): void => {
    notices.push({ id: notices.length + 1, runId: 'r1', message });
    show(status, shellsOpen);
  };

  it('announces a finished turn with nothing left running', () => {
    show('running');
    show('completed');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('announces a finished turn with a command still running, as a banner it can take back', () => {
    // The reported case: the agent finished and left a dev server up.
    show('running', 1);
    show('completed', 1);
    expect(notify).toHaveBeenCalledWith({
      kind: 'turn-end',
      runId: 'r1',
      title: 'r1',
      body: 'The turn finished — 1 command still running.',
      retractable: true,
    });
    expect(retractNotification).not.toHaveBeenCalled();
  });

  it('withdraws that banner when the run goes back to work — the agent was only waiting', () => {
    show('running', 1);
    show('completed', 1);
    // The command reported back and the CLI opened a turn of its own.
    show('running', 0);
    expect(retractNotification).toHaveBeenCalledWith('r1');

    // That continuation's ending is the real one, and it is final.
    show('completed', 0);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]![0]).not.toHaveProperty('retractable');
  });

  it('leaves the banner standing while nothing reopens the run', () => {
    show('running', 1);
    show('completed', 1);
    show('completed', 1);
    show('completed', 0);
    expect(retractNotification).not.toHaveBeenCalled();
  });

  it('never withdraws a final banner', () => {
    show('running');
    show('completed');
    show('running');
    show('completed');
    expect(retractNotification).not.toHaveBeenCalled();
  });

  it('still announces a FAILED turn while a command is running — nobody asked for it', () => {
    show('running', 1);
    show('failed', 1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("posts the agent's own notification, in its words", () => {
    show('running', 1);
    agentSays(
      'The dev server is running at http://localhost:3000.',
      'running',
      1,
    );
    expect(notify).toHaveBeenCalledWith({
      kind: 'turn-end',
      runId: 'r1',
      title: 'r1',
      body: 'The dev server is running at http://localhost:3000.',
    });
  });

  it('posts each notice once, however often the list re-renders', () => {
    show('running', 1);
    agentSays('Ready to try.', 'running', 1);
    show('running', 1);
    show('running', 1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not announce the ending of a turn whose agent already notified', () => {
    show('running');
    agentSays('All done — the build is green.', 'running');
    show('completed');
    // The one banner is the agent's own — not the turn's plain ending.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'All done — the build is green.' }),
    );
  });

  it("announces the NEXT turn's ending as usual after a notice", () => {
    show('running');
    agentSays('Ready.', 'running');
    show('completed');
    show('running');
    show('completed');
    expect(notify.mock.calls.map(([payload]) => payload.body)).toEqual([
      'Ready.',
      'The turn finished.',
    ]);
  });

  it('never skips a question', () => {
    show('running', 1);
    show('needs-input', 1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('useRunNotifications — an ending whose settle is still owed', () => {
  // The open thread ends on its terminal ITEM, which lands before the settle
  // announce that says whether the turn was housekeeping — so its ending waits
  // for that announce instead of reading the previous turn's verdict.
  let container: HTMLDivElement;
  let root: Root;
  const notify = vi.fn<GeniroApi['notify']>(async () => {});

  function SettlingProbe({
    status,
    quiet,
    settling,
  }: {
    status: RunStatusKind;
    quiet: ReadonlySet<string>;
    settling: ReadonlySet<string>;
  }): null {
    useRunNotifications({
      runs: [{ id: 'r1', status, shellsOpen: 0 }],
      statusOf,
      labelOf,
      awaitingOf,
      shellsOpenOf,
      quiet,
      settling,
      activeRunId: null,
    });
    return null;
  }

  const NONE: ReadonlySet<string> = new Set();
  const R1: ReadonlySet<string> = new Set(['r1']);

  const show = (
    status: RunStatusKind,
    { quiet = NONE, settling = NONE } = {},
  ): void => {
    act(() =>
      root.render(
        <SettlingProbe status={status} quiet={quiet} settling={settling} />,
      ),
    );
  };

  beforeEach(() => {
    notify.mockClear();
    window.geniro = createPreloadStub({ notify });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('holds the ending until the settle lands, then posts it', () => {
    show('running', { settling: R1 });
    show('completed', { settling: R1 });
    expect(notify).not.toHaveBeenCalled();

    show('completed');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('drops it when that settle says the turn was only housekeeping', () => {
    show('running', { settling: R1 });
    show('completed', { settling: R1 });
    show('completed', { quiet: R1 });
    expect(notify).not.toHaveBeenCalled();
  });

  it('drops it when the run goes back to work before its settle lands', () => {
    // That ending no longer describes the run — the next one will.
    show('running', { settling: R1 });
    show('completed', { settling: R1 });
    show('running', { settling: R1 });
    show('running');
    expect(notify).not.toHaveBeenCalled();
  });

  it('never holds a question', () => {
    show('running', { settling: R1 });
    show('needs-input', { settling: R1 });
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('useShareSignInNotifications', () => {
  let container: HTMLDivElement;
  let root: Root;
  const notify = vi.fn<GeniroApi['notify']>(async () => {});
  let listeners: Set<(event: SharesChangedEvent) => void>;
  const client = {
    onSharesChanged: (listener: (event: SharesChangedEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const event: SharesChangedEvent = {
    runId: 'r1',
    shareId: 's1',
    status: 'awaiting-sign-in',
    title: 'Delivery report',
    destinationName: 'Team bucket',
    askedByAgent: true,
    signInRequested: true,
  };

  function SignInProbe({ activeRunId }: { activeRunId: string | null }): null {
    useShareSignInNotifications({
      client,
      runs: [{ id: 'r1' }],
      labelOf: () => 'Ship the report',
      activeRunId,
    });
    return null;
  }

  beforeEach(() => {
    notify.mockClear();
    listeners = new Set();
    window.geniro = createPreloadStub({ notify });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const announce = (next: SharesChangedEvent): void => {
    act(() => {
      for (const listener of listeners) {
        listener(next);
      }
    });
  };

  it('posts one share-sign-in banner, titled with the thread, when an agent’s share starts waiting', () => {
    act(() => root.render(<SignInProbe activeRunId={null} />));

    announce(event);
    announce({ ...event, signInRequested: false });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      kind: 'share-sign-in',
      runId: 'r1',
      title: 'Ship the report',
      body: expect.stringContaining('sign in to Team bucket'),
    });
    expect(JSON.stringify(notify.mock.calls)).not.toContain('#k=');
  });

  it('stays quiet while the user is looking at that chat', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    act(() => root.render(<SignInProbe activeRunId="r1" />));

    announce(event);

    expect(notify).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('useLessonsFiledNotifications', () => {
  let container: HTMLDivElement;
  let root: Root;
  const notify = vi.fn<GeniroApi['notify']>(async () => {});
  let listeners: Set<(event: LessonsChangedEvent) => void>;
  const client = {
    onLessonsChanged: (listener: (event: LessonsChangedEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  function LessonsProbe({ activeRunId }: { activeRunId: string | null }): null {
    useLessonsFiledNotifications({
      client,
      runs: [{ id: 'r1' }],
      labelOf: () => 'Migrate the cache',
      activeRunId,
    });
    return null;
  }

  beforeEach(() => {
    notify.mockClear();
    listeners = new Set();
    window.geniro = createPreloadStub({ notify });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const announce = (next: LessonsChangedEvent): void => {
    act(() => {
      for (const listener of listeners) {
        listener(next);
      }
    });
  };

  it('posts one lessons banner, titled with the thread, when a reflection’s card lands with lessons', () => {
    act(() => root.render(<LessonsProbe activeRunId={null} />));

    announce({ runId: 'r1', filed: { saved: 2, waiting: 1 } });
    announce({ runId: 'r1' });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      kind: 'lessons',
      runId: 'r1',
      title: 'Migrate the cache',
      body: '2 lessons saved to memory · 1 lesson waits for your review',
    });
  });

  it('posts nothing for a reflection that filed nothing', () => {
    act(() => root.render(<LessonsProbe activeRunId={null} />));

    announce({ runId: 'r1', filed: { saved: 0, waiting: 0 } });

    expect(notify).not.toHaveBeenCalled();
  });

  it('stays quiet while the user is looking at that chat', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    act(() => root.render(<LessonsProbe activeRunId="r1" />));

    announce({ runId: 'r1', filed: { saved: 1, waiting: 0 } });

    expect(notify).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('still posts for the open chat while its window is in the background', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => root.render(<LessonsProbe activeRunId="r1" />));

    announce({ runId: 'r1', filed: { saved: 1, waiting: 0 } });

    expect(notify).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
