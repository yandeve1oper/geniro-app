import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

/** How long a chain of synchronous statements may hold the event loop before it gives up a turn. */
export const EVENT_LOOP_SLICE_MS = 50;

/**
 * A turn-taker for one chain of synchronous reads: each call gives the event
 * loop a turn only once the chain has held it for a slice since its last turn.
 * A turn per read would let every queued piece of background work cut in
 * before each one, stretching a quick read by all of them.
 */
export function eventLoopSlicer(
  sliceMs = EVENT_LOOP_SLICE_MS,
  now: () => number = () => performance.now(),
): () => Promise<void> {
  let since = now();
  return async () => {
    if (now() - since < sliceMs) {
      return;
    }
    await yieldToEventLoop();
    since = now();
  };
}
