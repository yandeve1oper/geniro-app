// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  holdReadingPlace,
  READING_ANCHOR_MAX_MS,
  READING_ANCHOR_SETTLE_MS,
  type ReadingAnchorClock,
} from './reading-anchor';

/**
 * A scroller whose rows sit at fixed CONTENT offsets, so the spec can move a
 * row (something above it grew) or scroll the viewport, and read back where the
 * hold put `scrollTop`. jsdom computes no layout, so both rects are derived,
 * a negative top margin on the first child lifting every row as layout would.
 */
function makeScroller(rowOffsets: number[]): {
  scroller: HTMLElement;
  rows: HTMLElement[];
  setOffset: (index: number, offset: number) => void;
} {
  const scroller = document.createElement('div');
  document.body.append(scroller);
  const offsets = [...rowOffsets];
  const rows = offsets.map((_, index) => {
    const row = document.createElement('div');
    row.getBoundingClientRect = () => {
      const first = scroller.firstElementChild;
      const lift =
        first instanceof HTMLElement
          ? parseFloat(first.style.marginTop) || 0
          : 0;
      const top = offsets[index]! + lift - scroller.scrollTop;
      return { top, bottom: top + 100 } as DOMRect;
    };
    scroller.append(row);
    return row;
  });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect;
  return {
    scroller,
    rows,
    setOffset: (index, offset) => {
      offsets[index] = offset;
    },
  };
}

function manualClock(): ReadingAnchorClock & {
  step: (ms?: number) => void;
  pending: () => number;
} {
  let time = 0;
  let queue: (() => void)[] = [];
  return {
    frame: (callback) => {
      queue.push(callback);
    },
    now: () => time,
    step: (ms = 16) => {
      time += ms;
      const run = queue;
      queue = [];
      for (const callback of run) {
        callback();
      }
    },
    pending: () => queue.length,
  };
}

describe('holdReadingPlace', () => {
  it('pays back growth ABOVE the first visible row, whenever it lands', () => {
    const { scroller, setOffset } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350; // row 1 (300–400) is the first visible
    const clock = manualClock();
    const hold = holdReadingPlace(scroller, clock);

    // The page arrives: 5,000px above everything on screen.
    setOffset(1, 5_300);
    setOffset(2, 6_000);
    clock.step();
    expect(scroller.scrollTop).toBe(5_350);

    // An image above settles two frames later — still held.
    hold.release();
    setOffset(1, 5_420);
    setOffset(2, 6_120);
    clock.step();
    expect(scroller.scrollTop).toBe(5_470);
  });

  it('writes nothing while a gesture owns the scroll, then pays the whole shift back once it lets go', () => {
    const { scroller, setOffset } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    let gesture = true;
    const hold = holdReadingPlace(scroller, clock, () => gesture);

    setOffset(1, 5_300);
    setOffset(2, 6_000);
    clock.step();
    expect(scroller.scrollTop).toBe(350);

    // The finger keeps dragging while the shift is owed, and the hold outlives
    // its settle and its cap rather than drop what it owes.
    scroller.scrollTop = 300;
    hold.release();
    clock.step(READING_ANCHOR_SETTLE_MS);
    expect(clock.pending()).toBe(1);
    clock.step(READING_ANCHOR_MAX_MS);
    expect(scroller.scrollTop).toBe(300);
    expect(clock.pending()).toBe(1);

    gesture = false;
    clock.step();
    expect(scroller.scrollTop).toBe(5_300);
    expect(clock.pending()).toBe(0);
  });

  it('lifts the content while a gesture owns the scroll, so the reader sees nothing move, then trades the lift for one scroll write', () => {
    const { scroller, rows, setOffset } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    let gesture = true;
    holdReadingPlace(scroller, clock, () => gesture).release();
    const onScreen = (): number => rows[1]!.getBoundingClientRect().top;
    expect(onScreen()).toBe(-50);

    setOffset(1, 5_300);
    setOffset(2, 6_000);
    clock.step();
    expect(scroller.scrollTop).toBe(350);
    expect(rows[0]!.style.marginTop).toBe('-5000px');
    expect(onScreen()).toBe(-50);

    // A second page lands in front while the finger is still down: the lift
    // moves onto the new first child and grows by what it brought.
    const arrived = document.createElement('div');
    scroller.prepend(arrived);
    setOffset(1, 9_300);
    setOffset(2, 10_000);
    clock.step();
    expect(rows[0]!.style.marginTop).toBe('');
    expect(arrived.style.marginTop).toBe('-9000px');
    expect(onScreen()).toBe(-50);

    gesture = false;
    clock.step();
    expect(arrived.style.marginTop).toBe('');
    expect(scroller.scrollTop).toBe(9_350);
    expect(onScreen()).toBe(-50);
  });

  it('ignores growth BELOW the reader, which a height-delta correction paid back too', () => {
    const { scroller, setOffset } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);

    // A streaming reply grows at the tail; nothing above row 1 moved.
    setOffset(2, 1_900);
    clock.step();
    expect(scroller.scrollTop).toBe(350);
  });

  it('pays back a SHRINK above the reader as well', () => {
    const { scroller, setOffset } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);
    setOffset(1, 292); // the loading row is 8px shorter than the button
    clock.step();
    expect(scroller.scrollTop).toBe(342);
  });

  it('does not fight the reader scrolling during the hold', () => {
    const { scroller } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);
    scroller.scrollTop = 120; // the reader keeps going up
    clock.step();
    expect(scroller.scrollTop).toBe(120);
  });

  it('stops once the layout has been still for the settle window after release', () => {
    const { scroller } = makeScroller([0, 300]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    const hold = holdReadingPlace(scroller, clock);
    clock.step();
    expect(clock.pending()).toBe(1); // still holding while the page loads
    hold.release();
    clock.step(READING_ANCHOR_SETTLE_MS);
    expect(clock.pending()).toBe(0);
  });

  it('never outlives its ceiling, however much keeps moving', () => {
    const { scroller, setOffset } = makeScroller([0, 300]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    const hold = holdReadingPlace(scroller, clock);
    hold.release();
    let offset = 300;
    for (let t = 0; t < READING_ANCHOR_MAX_MS; t += 100) {
      offset += 1;
      setOffset(1, offset);
      clock.step(100);
    }
    expect(clock.pending()).toBe(0);
  });

  it('never anchors on the older-messages row the press came from', () => {
    const { scroller, rows, setOffset } = makeScroller([0, 300]);
    rows[0]!.dataset.slot = 'older-messages';
    scroller.scrollTop = 0; // the older row (0–100) is the first visible
    const clock = manualClock();
    holdReadingPlace(scroller, clock);
    setOffset(1, 5_300);
    clock.step();
    expect(scroller.scrollTop).toBe(5_000);
  });

  it('prefers a row that STARTS in view over the boundary row the page grows into', () => {
    // Rows 0 (0–100) and 1 (300–400); the reader at 50 sees row 0 cut off at
    // the top and row 1 whole. A page growing INTO row 0 moves nothing about
    // row 0's own top, while everything below it moves.
    const { scroller, setOffset } = makeScroller([0, 300]);
    scroller.scrollTop = 50;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);
    setOffset(1, 1_300);
    clock.step();
    expect(scroller.scrollTop).toBe(1_050);
  });

  it('passes over the TOPMOST row even when it starts in view — the page merges into it', () => {
    // After "Load earlier messages" the reader sits at the very top: the first
    // entry starts in view, and it is the one an older page grows into (and
    // remounts under a new key). The next entry is the stable anchor.
    const { scroller, rows, setOffset } = makeScroller([0, 300]);
    scroller.scrollTop = 0;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);
    rows[0]!.remove(); // re-keyed by the merge
    setOffset(1, 1_300);
    clock.step();
    expect(scroller.scrollTop).toBe(1_000);
  });

  it('finds a REMOUNTED anchor by its seq and still pays the shift', () => {
    const { scroller, rows, setOffset } = makeScroller([0, 300, 1_000]);
    rows[1]!.setAttribute('data-transcript-seq', '42');
    scroller.scrollTop = 350;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);
    // The entry re-keys: a new element with the same seq, 900px further down.
    rows[1]!.remove();
    const again = document.createElement('div');
    again.setAttribute('data-transcript-seq', '42');
    again.getBoundingClientRect = () =>
      ({
        top: 1_200 - scroller.scrollTop,
        bottom: 1_300 - scroller.scrollTop,
      }) as DOMRect;
    scroller.prepend(again);
    setOffset(2, 1_900);
    clock.step();
    expect(scroller.scrollTop).toBe(1_250);
  });

  it('a second load JOINS the running hold rather than paying the shift twice', () => {
    const { scroller, setOffset } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    const first = holdReadingPlace(scroller, clock);
    first.release(); // a refused load releases at once…
    const second = holdReadingPlace(scroller, clock); // …while the real one starts
    setOffset(1, 5_300);
    clock.step();
    expect(scroller.scrollTop).toBe(5_350);
    expect(clock.pending()).toBe(1);
    second.release();
    clock.step(READING_ANCHOR_SETTLE_MS);
    expect(clock.pending()).toBe(0);
  });

  it('re-anchors on what is visible when its row is regrouped away', () => {
    const { scroller, rows, setOffset } = makeScroller([0, 300, 1_000]);
    scroller.scrollTop = 350;
    const clock = manualClock();
    holdReadingPlace(scroller, clock);
    rows[1]!.remove();
    clock.step(); // re-anchors on row 2, pays nothing this frame
    expect(scroller.scrollTop).toBe(350);
    setOffset(2, 1_200);
    clock.step();
    expect(scroller.scrollTop).toBe(550);
  });
});
