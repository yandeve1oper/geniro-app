import { useEffect, useRef, useState } from 'react';

import { useLatestCallback } from './components/use-latest-callback';
import type { DaemonClient } from './daemon-client';

/**
 * How long a burst of recorded turns accumulates before a live read re-reads. A
 * team settles its nodes within a second or two of each other, each writing a
 * ledger row, so without it the last node would be the fifth refetch of one answer.
 */
export const LIVE_REFRESH_DEBOUNCE_MS = 750;

export interface LiveDaemonRead<T> {
  data: T | null;
  /** True only while the first read for the current key is in flight. */
  loading: boolean;
  error: string | null;
  /** Read again — what a Retry control does. */
  reload: () => void;
  /** Clear the error without reading again, so a banner's close control can close it. */
  dismiss: () => void;
}

/**
 * A daemon read kept CURRENT while mounted: read whenever `key` changes (a null key
 * reads nothing), and again a beat after each turn the daemon records
 * (`usage_recorded`) — pushed, not polled. The figures are the daemon's; a caller
 * refetches rather than patching them.
 *
 * `keepOnKeyChange` keeps the previous key's answer on screen while the new one loads
 * (switching a period need not blank a page); without it a new key starts empty, so
 * one subject's figures are never shown under another's name. An answer that lands
 * after its key changed is dropped either way.
 *
 * `active` false (a screen kept mounted while hidden) holds every turn's re-read: a
 * heavy figure read on each turn nobody looks at stalls the daemon for every other
 * request. The screen reads once when shown again, and only if a turn was missed.
 */
export function useLiveDaemonRead<S extends object, T>(
  source: S | null,
  key: string | null,
  read: (source: S) => Promise<T>,
  options: {
    client?: DaemonClient | null;
    keepOnKeyChange?: boolean;
    active?: boolean;
  } = {},
): LiveDaemonRead<T> {
  const { client, keepOnKeyChange = false, active = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useLatestCallback(() => setNonce((value) => value + 1), []);
  const dismiss = useLatestCallback(() => setError(null), []);

  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    if (!keepOnKeyChange) {
      setData(null);
      setLoading(true);
      setError(null);
    }
  }

  // Read through a ref: callers pass an inline function, and the read must follow
  // the key and the source, not every render that produced a new closure.
  const readRef = useRef(read);
  readRef.current = read;
  const activeRef = useRef(active);
  activeRef.current = active;
  const missedRef = useRef(false);

  useEffect(() => {
    if (!source || key === null) {
      return;
    }
    let cancelled = false;
    missedRef.current = false;
    setError(null);
    readRef
      .current(source)
      .then((answer) => {
        if (!cancelled) {
          setData(answer);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [source, key, nonce]);

  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const reading = key !== null;

  useEffect(() => {
    if (!client || !reading) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = client.onUsageRecorded(() => {
      // Trailing: the LAST event of a burst is the one worth reading after.
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        if (activeRef.current) {
          reloadRef.current();
        } else {
          missedRef.current = true;
        }
      }, LIVE_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [client, reading]);

  useEffect(() => {
    if (active && missedRef.current) {
      missedRef.current = false;
      reloadRef.current();
    }
  }, [active]);

  return { data, loading, error, reload, dismiss };
}
