import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  CliKind,
  CliUpdateResult,
  CliUpdates,
} from '../../shared/contracts';
import { useLatestCallback } from '../components/use-latest-callback';

const NO_UPDATES: CliUpdates = { updating: [], results: {} };

/** How often a running update is re-read, for a paired device that gets no pushes. */
export const CLI_UPDATES_POLL_MS = 3000;

export interface CliUpdatesController {
  updating: ReadonlySet<CliKind>;
  results: Partial<Record<CliKind, CliUpdateResult>>;
  update: (kind: CliKind) => Promise<void>;
  /** Drops the kept outcomes, for a fresh reading. */
  forget: () => Promise<void>;
}

/**
 * The CLI updates main is running, read from main so a screen mounted mid-update
 * still shows it running. `onFinished` fires once per CLI whose update ended
 * while this hook was mounted, the moment to read the CLIs again.
 */
export function useCliUpdates(
  onFinished: (kind: CliKind) => void,
): CliUpdatesController {
  const [state, setState] = useState<CliUpdates>(NO_UPDATES);
  const pushed = useRef(false);
  const seenUpdating = useRef<ReadonlySet<CliKind>>(new Set());

  const adopt = useLatestCallback((next: CliUpdates): void => {
    const now = new Set(next.updating);
    for (const kind of seenUpdating.current) {
      if (!now.has(kind)) {
        onFinished(kind);
      }
    }
    seenUpdating.current = now;
    setState(next);
  }, []);

  const reread = useLatestCallback(async (): Promise<void> => {
    adopt(await window.geniro.getCliUpdates());
  }, []);

  useEffect(() => {
    const unsubscribe = window.geniro.onCliUpdates((next) => {
      pushed.current = true;
      adopt(next);
    });
    void window.geniro
      .getCliUpdates()
      .then((initial) => {
        if (!pushed.current) {
          adopt(initial);
        }
      })
      .catch(() => undefined);
    return unsubscribe;
  }, [adopt]);

  const running = state.updating.length > 0;
  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setInterval(() => {
      void reread().catch(() => undefined);
    }, CLI_UPDATES_POLL_MS);
    return () => clearInterval(timer);
  }, [running, reread]);

  const update = useLatestCallback(async (kind: CliKind): Promise<void> => {
    const run = window.geniro.updateCli(kind);
    await reread().catch(() => undefined);
    await run.catch(() => undefined);
    await reread().catch(() => undefined);
  }, []);

  const forget = useLatestCallback(async (): Promise<void> => {
    adopt(await window.geniro.forgetCliUpdateResults());
  }, []);

  const updating = useMemo(() => new Set(state.updating), [state.updating]);

  return { updating, results: state.results, update, forget };
}
