import { useEffect, useRef, useState } from 'react';

import type { CliDetection } from '../../shared/contracts';
import { DETECTION_MAX_AGE_MS } from '../teams/use-sign-in-health';
import { useCliUpdates } from './use-cli-updates';

/** The installed CLIs that said a newer version of themselves exists. */
export function countCliUpdatesAvailable(
  detections: readonly CliDetection[],
): number {
  return detections.filter(
    (detection) => detection.found && detection.update.available === true,
  ).length;
}

/**
 * How many agent CLIs have an update waiting, for the nav rail's Settings
 * badge. Read from main's cached detection on mount and on focus, and fresh
 * once an update finishes.
 */
export function useCliUpdatesAvailable(): number {
  const [count, setCount] = useState(0);
  const live = useRef(true);

  const read = (fresh: boolean): void => {
    void window.geniro
      .detectClis(fresh ? undefined : { maxAgeMs: DETECTION_MAX_AGE_MS })
      .then((detections) => {
        if (live.current) {
          setCount(countCliUpdatesAvailable(detections));
        }
      })
      .catch(() => undefined);
  };

  useCliUpdates(() => read(true));

  useEffect(() => {
    live.current = true;
    read(false);
    const onFocus = (): void => read(false);
    window.addEventListener('focus', onFocus);
    return () => {
      live.current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return count;
}
