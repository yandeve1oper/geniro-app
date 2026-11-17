// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliDetection, CliKind, CliUpdates } from '../../shared/contracts';
import { DETECTION_MAX_AGE_MS } from '../teams/use-sign-in-health';
import { useCliUpdatesAvailable } from './use-cli-updates-available';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function det(
  kind: CliKind,
  available: boolean | null,
  found = true,
): CliDetection {
  return {
    kind,
    found,
    path: found ? `/bin/${kind}` : null,
    version: '1.0.0',
    loggedIn: null,
    update: { available, latestVersion: null, checkUnavailableReason: null },
  };
}

function Probe(): React.JSX.Element {
  return <output>{useCliUpdatesAvailable()}</output>;
}

let container: HTMLDivElement;
let root: Root;
let push: (state: CliUpdates) => void;
let detectClis: ReturnType<typeof vi.fn>;

beforeEach(() => {
  detectClis = vi.fn();
  Object.assign(window, {
    geniro: {
      detectClis,
      getCliUpdates: () => Promise.resolve({ updating: [], results: {} }),
      onCliUpdates: (listener: (state: CliUpdates) => void) => {
        push = listener;
        return () => undefined;
      },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useCliUpdatesAvailable', () => {
  it('counts only installed CLIs that said a newer version exists, from a cached detection', async () => {
    detectClis.mockResolvedValue([
      det('claude', true),
      det('codex', null),
      det('cursor-agent', true, false),
    ]);

    await act(async () => {
      root.render(<Probe />);
    });

    expect(container.textContent).toBe('1');
    expect(detectClis).toHaveBeenCalledWith({ maxAgeMs: DETECTION_MAX_AGE_MS });
  });

  it('reads the CLIs afresh once an update ends, so the badge drops the CLI just updated', async () => {
    detectClis.mockResolvedValueOnce([det('claude', true)]);
    await act(async () => {
      root.render(<Probe />);
    });
    detectClis.mockResolvedValue([det('claude', false)]);

    await act(async () => {
      push({ updating: ['claude'], results: {} });
    });
    expect(detectClis).toHaveBeenCalledTimes(1);
    await act(async () => {
      push({ updating: [], results: {} });
    });

    expect(detectClis).toHaveBeenLastCalledWith(undefined);
    expect(container.textContent).toBe('0');
  });
});
