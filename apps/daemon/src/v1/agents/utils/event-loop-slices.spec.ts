import { describe, expect, it } from 'vitest';

import { eventLoopSlicer } from './event-loop-slices';

/** Whether a turn of the event loop passed while `step` ran. */
async function gaveATurn(step: () => Promise<void>): Promise<boolean> {
  let turned = false;
  setImmediate(() => {
    turned = true;
  });
  await step();
  return turned;
}

describe('eventLoopSlicer', () => {
  it('keeps the loop while the chain is inside its slice', async () => {
    let clock = 0;
    const slice = eventLoopSlicer(50, () => clock);
    clock = 49;

    expect(await gaveATurn(slice)).toBe(false);
  });

  it('gives a turn once the chain has held the loop for a slice, then counts the next slice from there', async () => {
    let clock = 0;
    const slice = eventLoopSlicer(50, () => clock);
    clock = 50;

    expect(await gaveATurn(slice)).toBe(true);

    clock = 99;
    expect(await gaveATurn(slice)).toBe(false);
    clock = 100;
    expect(await gaveATurn(slice)).toBe(true);
  });
});
