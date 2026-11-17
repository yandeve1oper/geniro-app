// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

import type { DaemonClient } from './daemon-client';
import { type LiveDaemonRead, useLiveDaemonRead } from './use-live-daemon-read';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = {};

let container: HTMLDivElement;
let root: Root;
let latest: LiveDaemonRead<string>;
let recorded: (() => void)[];

function client(): DaemonClient {
  return {
    onUsageRecorded: (listener: () => void) => {
      recorded.push(listener);
      return () => undefined;
    },
  } as unknown as DaemonClient;
}

function Probe(props: {
  readKey: string | null;
  read: (source: object) => Promise<string>;
  keepOnKeyChange?: boolean;
  liveClient?: DaemonClient | null;
  active?: boolean;
}): null {
  latest = useLiveDaemonRead(SOURCE, props.readKey, props.read, {
    client: props.liveClient ?? null,
    keepOnKeyChange: props.keepOnKeyChange,
    active: props.active,
  });
  return null;
}

function recordTurn(): void {
  act(() => {
    recorded.forEach((listener) => listener());
  });
}

/** A read whose answers the test releases by hand, one per call, in order. */
function heldReads(): {
  read: Mock<(source: object) => Promise<string>>;
  answer: (index: number, value: string) => Promise<void>;
} {
  const pending: ((value: string) => void)[] = [];
  const read = vi.fn<(source: object) => Promise<string>>(
    () =>
      new Promise<string>((resolve) => {
        pending.push(resolve);
      }),
  );
  return {
    read,
    answer: async (index, value) => {
      await act(async () => {
        pending[index]!(value);
      });
    },
  };
}

beforeEach(() => {
  recorded = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('useLiveDaemonRead', () => {
  it('reads nothing while the key is null', () => {
    const read = vi.fn(async () => 'never');
    act(() => root.render(<Probe readKey={null} read={read} />));

    expect(read).not.toHaveBeenCalled();
    expect(latest.data).toBeNull();
  });

  it('starts a new key empty and drops the previous key’s late answer', async () => {
    const { read, answer } = heldReads();
    act(() => root.render(<Probe readKey="dev-team" read={read} />));
    await answer(0, 'dev-team table');
    expect(latest.data).toBe('dev-team table');

    act(() => root.render(<Probe readKey="other" read={read} />));
    expect(latest).toMatchObject({ data: null, loading: true });

    act(() => root.render(<Probe readKey="third" read={read} />));
    await answer(1, 'other table (late)');
    expect(latest.data).toBeNull();

    await answer(2, 'third table');
    expect(latest).toMatchObject({ data: 'third table', loading: false });
  });

  it('keeps the previous answer on screen while a new key loads when asked to', async () => {
    const { read, answer } = heldReads();
    act(() => root.render(<Probe readKey="30d" read={read} keepOnKeyChange />));
    await answer(0, '30 days');

    act(() => root.render(<Probe readKey="90d" read={read} keepOnKeyChange />));
    expect(latest).toMatchObject({ data: '30 days', loading: false });

    await answer(1, '90 days');
    expect(latest.data).toBe('90 days');
  });

  it('reads again once, a beat after a burst of recorded turns', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => 'table');
    const live = client();
    await act(async () => {
      root.render(<Probe readKey="dev-team" read={read} liveClient={live} />);
    });
    expect(read).toHaveBeenCalledTimes(1);

    act(() => {
      recorded.forEach((listener) => listener());
      vi.advanceTimersByTime(500);
      recorded.forEach((listener) => listener());
    });
    await act(async () => {
      vi.advanceTimersByTime(749);
    });
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  describe('while its screen is hidden', () => {
    async function mountHidden(
      read: (source: object) => Promise<string>,
      live: DaemonClient,
    ): Promise<void> {
      await act(async () => {
        root.render(<Probe readKey="dev-team" read={read} liveClient={live} />);
      });
      await act(async () => {
        root.render(
          <Probe
            readKey="dev-team"
            read={read}
            liveClient={live}
            active={false}
          />,
        );
      });
    }

    async function show(
      read: (source: object) => Promise<string>,
      live: DaemonClient,
    ): Promise<void> {
      await act(async () => {
        root.render(
          <Probe readKey="dev-team" read={read} liveClient={live} active />,
        );
      });
    }

    it('does not read again on a recorded turn', async () => {
      vi.useFakeTimers();
      const read = vi.fn(async () => 'table');
      const live = client();
      await mountHidden(read, live);

      recordTurn();
      recordTurn();
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });

      expect(read).toHaveBeenCalledTimes(1);
    });

    it('reads once when shown again after turns it missed', async () => {
      vi.useFakeTimers();
      const read = vi.fn(async () => 'table');
      const live = client();
      await mountHidden(read, live);
      recordTurn();
      recordTurn();
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(read).toHaveBeenCalledTimes(1);

      await show(read, live);
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });

      expect(read).toHaveBeenCalledTimes(2);
    });

    it('reads nothing when shown again with no turn missed', async () => {
      vi.useFakeTimers();
      const read = vi.fn(async () => 'table');
      const live = client();
      await mountHidden(read, live);

      await show(read, live);
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });

      expect(read).toHaveBeenCalledTimes(1);
    });

    it('holds a re-read whose beat ends after the screen was hidden', async () => {
      vi.useFakeTimers();
      const read = vi.fn(async () => 'table');
      const live = client();
      await act(async () => {
        root.render(<Probe readKey="dev-team" read={read} liveClient={live} />);
      });
      recordTurn();
      await act(async () => {
        root.render(
          <Probe
            readKey="dev-team"
            read={read}
            liveClient={live}
            active={false}
          />,
        );
      });
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(read).toHaveBeenCalledTimes(1);

      await show(read, live);
      expect(read).toHaveBeenCalledTimes(2);
    });
  });
});
