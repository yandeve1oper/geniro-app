/**
 * Escape belongs to exactly one overlay: the one opened last. With a
 * `document` listener per overlay, each would close on every Escape, and a
 * popover opened inside a dialog would take the dialog — and its draft — down
 * with it.
 *
 * Ordered by OPENING, which is the order a user produces by opening one overlay
 * from inside another. Two that mount already open in the same commit are
 * ranked child-first (React runs a child's effects before its parent's).
 */
const layers: { close: () => void }[] = [];

function closeTopLayer(event: KeyboardEvent): void {
  // A control that owns Escape says so with `preventDefault` — a label field
  // abandoning its draft, a picker closing its menu (`menu.tsx`'s `consume()`).
  if (event.key !== 'Escape' || event.defaultPrevented) {
    return;
  }
  if (closeTopEscapeLayer()) {
    event.preventDefault();
  }
}

/**
 * Close the overlay on top, as an Escape the document saw would. For an Escape
 * pressed where the document cannot see it — inside an artifact's frame, which
 * hands it over by message. Answers whether there was one to close.
 */
export function closeTopEscapeLayer(): boolean {
  const top = layers[layers.length - 1];
  if (top === undefined) {
    return false;
  }
  top.close();
  return true;
}

/** Put an overlay on top of the Escape stack; answers the call that takes it off. */
export function pushEscapeLayer(layer: { close: () => void }): () => void {
  if (layers.length === 0) {
    document.addEventListener('keydown', closeTopLayer);
  }
  layers.push(layer);
  return () => {
    const index = layers.indexOf(layer);
    if (index !== -1) {
      layers.splice(index, 1);
    }
    if (layers.length === 0) {
      document.removeEventListener('keydown', closeTopLayer);
    }
  };
}
