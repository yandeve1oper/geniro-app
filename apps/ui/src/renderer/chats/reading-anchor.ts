/**
 * Keep the reader's place while older history is prepended above it.
 *
 * The transcript sets `overflow-anchor: none`, so nothing but this code holds
 * a reader still when rows land ABOVE the viewport. It anchors on a ROW rather
 * than on the scroller's total height, because the total also grows BELOW the
 * viewport — a streaming reply, a new item — and a height-delta correction adds
 * that growth to `scrollTop` too, overshooting the reader downward. A row's
 * offset inside the scroll content moves only when something above it changes
 * size, and it is independent of `scrollTop`, so a reader scrolling during the
 * hold is never fought: only the layout's movement is paid back.
 *
 * The anchor is the first row that STARTS inside the viewport, not the first
 * one visible: the topmost loaded entry is the one an older page grows into (a
 * tool group or turn block gains the rows before it), so its own top does not
 * move while everything the reader was looking at inside it does.
 *
 * The hold starts BEFORE the page is requested (the loading row itself swaps
 * in above the reader) and lasts until the layout has stopped moving, not for a
 * fixed number of frames — markdown images and artifact frames settle long
 * after React commits the page. There is ONE hold per scroller: a second load
 * joins it, since two holds would each pay back the same shift.
 *
 * While a finger or a fling owns the scroll (`gestureOwnsScroll`), `scrollTop`
 * is not written: mobile WebKit ignores the write under a dragging finger,
 * stops a fling dead on it (iOS 26 and earlier), and from Safari 27 lets the
 * fling carry on past it. The content is lifted instead, by a negative top
 * margin on the scroller's first child, so the reader sees nothing move; once
 * the gesture has let go the lift is taken off and paid back as one
 * `scrollTop` write in the same frame. The hold outlives its settle and its cap
 * while a lift stands.
 */

/** A row that has not moved for this long after the page landed has settled. */
export const READING_ANCHOR_SETTLE_MS = 600;
/** The hold never outlives this after its last release, however much moves. */
export const READING_ANCHOR_MAX_MS = 5_000;

/** Rows that are chrome around the transcript rather than a place to read. */
const NOT_A_ROW = '[data-slot="older-messages"], [data-slot="thread-loading"]';
/** The attribute an entry's wrapper carries — how a remounted anchor is found again. */
const SEQ_ATTRIBUTE = 'data-transcript-seq';

export interface ReadingAnchorClock {
  frame: (callback: () => void) => void;
  now: () => number;
}

const DEFAULT_CLOCK: ReadingAnchorClock = {
  frame: (callback) => {
    requestAnimationFrame(callback);
  },
  now: () => performance.now(),
};

interface Hold {
  anchor: HTMLElement | null;
  seq: string | null;
  last: number;
  holders: number;
  releasedAt: number | null;
  lastShiftAt: number;
  lift: number;
  liftHost: HTMLElement | null;
  gestureOwnsScroll: () => boolean;
}

const NO_GESTURE = (): boolean => false;

const active = new WeakMap<HTMLElement, Hold>();

function rows(scroller: HTMLElement): HTMLElement[] {
  return Array.from(scroller.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && !child.matches(NOT_A_ROW),
  );
}

/**
 * The first row that starts in view, else the first one reaching into it —
 * passing over the TOPMOST loaded row whenever another starts in view, since
 * that is the row an older page merges into and remounts under a new key.
 */
function pickAnchor(scroller: HTMLElement): HTMLElement | null {
  const { top, bottom } = scroller.getBoundingClientRect();
  const all = rows(scroller);
  let reaching: HTMLElement | null = null;
  let first: HTMLElement | null = null;
  for (const row of all) {
    const rect = row.getBoundingClientRect();
    if (rect.top >= top && rect.top < bottom) {
      if (row !== all[0]) {
        return row;
      }
      first ??= row;
      continue;
    }
    if (reaching === null && rect.bottom > top) {
      reaching = row;
    }
  }
  return first ?? reaching;
}

/** Where `row` sits inside the scroll CONTENT — unmoved by scrolling. */
function contentOffset(scroller: HTMLElement, row: HTMLElement): number {
  return (
    row.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop
  );
}

function liftContent(scroller: HTMLElement, hold: Hold, by: number): void {
  const first =
    scroller.firstElementChild instanceof HTMLElement
      ? scroller.firstElementChild
      : null;
  if (hold.liftHost !== null && (by === 0 || hold.liftHost !== first)) {
    hold.liftHost.style.marginTop = '';
    hold.liftHost = null;
  }
  hold.lift = by;
  if (by !== 0 && first !== null) {
    first.style.marginTop = `${-by}px`;
    hold.liftHost = first;
  }
}

function anchorOn(
  scroller: HTMLElement,
  hold: Hold,
  row: HTMLElement | null,
): void {
  hold.anchor = row;
  hold.seq = row?.getAttribute(SEQ_ATTRIBUTE) ?? null;
  hold.last = row === null ? 0 : contentOffset(scroller, row);
}

/**
 * Start (or join) holding the reader's place; call `release` once the page has
 * landed or failed to. The hold ends by itself once every holder has released
 * and the anchor has stopped moving.
 */
export function holdReadingPlace(
  scroller: HTMLElement,
  clock: ReadingAnchorClock = DEFAULT_CLOCK,
  gestureOwnsScroll: () => boolean = NO_GESTURE,
): { release: () => void } {
  const existing = active.get(scroller);
  const hold: Hold = existing ?? {
    anchor: null,
    seq: null,
    last: 0,
    holders: 0,
    releasedAt: null,
    lastShiftAt: clock.now(),
    lift: 0,
    liftHost: null,
    gestureOwnsScroll,
  };
  hold.holders += 1;
  hold.releasedAt = null;
  let released = false;
  const handle = {
    release: (): void => {
      if (released) {
        return;
      }
      released = true;
      hold.holders -= 1;
      if (hold.holders === 0) {
        hold.releasedAt = clock.now();
        hold.lastShiftAt = hold.releasedAt;
      }
    },
  };
  if (existing !== undefined) {
    return handle;
  }
  active.set(scroller, hold);
  anchorOn(scroller, hold, pickAnchor(scroller));

  const tick = (): void => {
    if (!scroller.isConnected) {
      active.delete(scroller);
      return;
    }
    if (
      hold.anchor !== null &&
      !hold.anchor.isConnected &&
      hold.seq !== null &&
      /^\d+$/.test(hold.seq)
    ) {
      // Remounted under the same seq: the replacement stands where the old
      // row would have, so the shift is still owed.
      hold.anchor = scroller.querySelector<HTMLElement>(
        `[${SEQ_ATTRIBUTE}="${hold.seq}"]`,
      );
    }
    if (hold.lift !== 0 && hold.liftHost !== scroller.firstElementChild) {
      liftContent(scroller, hold, hold.lift);
    }
    if (hold.anchor === null || !hold.anchor.isConnected) {
      anchorOn(scroller, hold, pickAnchor(scroller));
    } else {
      const shift =
        contentOffset(scroller, hold.anchor) + hold.lift - hold.last;
      if (Math.abs(shift) < 0.5) {
        liftContent(scroller, hold, 0);
        hold.last = contentOffset(scroller, hold.anchor);
      } else if (hold.gestureOwnsScroll()) {
        if (Math.abs(shift - hold.lift) >= 0.5) {
          liftContent(scroller, hold, shift);
          hold.lastShiftAt = clock.now();
        }
      } else {
        liftContent(scroller, hold, 0);
        scroller.scrollTop += shift;
        hold.last = contentOffset(scroller, hold.anchor);
        hold.lastShiftAt = clock.now();
      }
    }
    const at = clock.now();
    if (
      hold.releasedAt !== null &&
      hold.lift === 0 &&
      (at - hold.lastShiftAt >= READING_ANCHOR_SETTLE_MS ||
        at - hold.releasedAt >= READING_ANCHOR_MAX_MS)
    ) {
      active.delete(scroller);
      return;
    }
    clock.frame(tick);
  };
  clock.frame(tick);
  return handle;
}
