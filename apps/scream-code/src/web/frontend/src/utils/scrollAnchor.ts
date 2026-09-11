/**
 * Scroll anchoring helpers for a top-anchored (non-inverted) scroll container.
 *
 * When rows are inserted ABOVE (or removed from above) the current viewport —
 * a list window sliding up, or an older page being prepended — the browser
 * keeps `scrollTop` untouched, so the visible content appears to jump by the
 * height of the insertion. Capturing the distance from the viewport top to the
 * document top *before* the DOM patch and restoring it *after* keeps the same
 * content under the same pixel offset:
 *
 *   distance = scrollHeight_before - scrollTop_before
 *   scrollTop_after = scrollHeight_after - distance
 *                   = scrollTop_before + (scrollHeight_after - scrollHeight_before)
 *
 * which is exactly "shift by the inserted height". Both are pure numbers so
 * they can be unit-tested without a DOM.
 */

/** Distance from the viewport top down to the end of the content. */
export function captureScrollDistance(scrollHeight: number, scrollTop: number): number {
  return scrollHeight - scrollTop;
}

/**
 * `scrollTop` that puts the captured distance back under the current viewport.
 * Clamped at 0: a saved distance larger than the (now shorter) content means
 * there is nothing above left to keep in view.
 */
export function restoreScrollTop(scrollHeight: number, savedDistance: number): number {
  return Math.max(0, scrollHeight - savedDistance);
}
