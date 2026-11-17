// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliKind, CliUpdates } from '../../shared/contracts';
import { CLI_UPDATES_POLL_MS, useCliUpdates } from './use-cli-updates';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const finished: CliKind[] = [];

function Probe(): React.JSX.Element {
  const { updating, results } = useCliUpdates((kind) => finished.push(kind));
  return (
    <output>
      {[...updating].join(',')}|{Object.keys(results).join(',')}
    </output>
  );
}

let container: HTMLDivElement;
let root: Root;
let push: (state: CliUpdates) => void;

function stubMain(initial: CliUpdates): void {
  Object.assign(window, {
    geniro: {
      getCliUpdates: vi.fn(() => Promise.resolve(initial)),
      onCliUpdates: vi.fn((listener: (state: CliUpdates) => void) => {
        push = listener;
        return () => undefined;
      }),
    },
  });
}

beforeEach(() => {
  finished.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useCliUpdates', () => {
  it('shows an update main is still running to a screen mounted after the press', async () => {
    stubMain({ updating: ['codex'], results: {} });

    await act(async () => {
      root.render(<Probe />);
    });

    expect(container.textContent).toBe('codex|');
  });

  it('shows the press running and then its outcome without any push, as on a paired device', async () => {
    let finish!: () => void;
    let mainState: CliUpdates = { updating: [], results: {} };
    const result = {
      kind: 'codex' as const,
      ok: true,
      previousVersion: '0.166.0',
      version: '0.169.0',
      output: null,
      reason: null,
    };
    let controller!: ReturnType<typeof useCliUpdates>;
    function Pressing(): React.JSX.Element {
      controller = useCliUpdates((kind) => finished.push(kind));
      return (
        <output>
          {[...controller.updating].join(',')}|
          {Object.keys(controller.results).join(',')}
        </output>
      );
    }
    Object.assign(window, {
      geniro: {
        getCliUpdates: vi.fn(() => Promise.resolve(mainState)),
        onCliUpdates: () => () => undefined,
        updateCli: vi.fn(() => {
          mainState = { updating: ['codex'], results: {} };
          return new Promise((resolve) => {
            finish = () => {
              mainState = { updating: [], results: { codex: result } };
              resolve(result);
            };
          });
        }),
      },
    });
    await act(async () => {
      root.render(<Pressing />);
    });

    let pressed!: Promise<void>;
    await act(async () => {
      pressed = controller.update('codex');
    });
    expect(container.textContent).toBe('codex|');

    await act(async () => {
      finish();
      await pressed;
    });
    expect(container.textContent).toBe('|codex');
    expect(finished).toEqual(['codex']);
  });

  it('re-reads main while an update runs, so a screen that gets no push still sees it end', async () => {
    vi.useFakeTimers();
    try {
      let mainState: CliUpdates = { updating: ['claude'], results: {} };
      const getCliUpdates = vi.fn(() => Promise.resolve(mainState));
      Object.assign(window, {
        geniro: { getCliUpdates, onCliUpdates: () => () => undefined },
      });
      await act(async () => {
        root.render(<Probe />);
      });
      expect(container.textContent).toBe('claude|');

      mainState = { updating: [], results: {} };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CLI_UPDATES_POLL_MS);
      });

      expect(container.textContent).toBe('|');
      expect(finished).toEqual(['claude']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the CLI whose update ended, once, when main says so', async () => {
    stubMain({ updating: ['codex'], results: {} });
    await act(async () => {
      root.render(<Probe />);
    });

    act(() => {
      push({
        updating: [],
        results: {
          codex: {
            kind: 'codex',
            ok: true,
            previousVersion: '0.166.0',
            version: '0.169.0',
            output: null,
            reason: null,
          },
        },
      });
    });
    act(() => {
      push({ updating: [], results: {} });
    });

    expect(finished).toEqual(['codex']);
    expect(container.textContent).toBe('|');
  });
});
