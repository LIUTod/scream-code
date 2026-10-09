/**
 * Gutter container whose render order may differ from the children array
 * order: one child can be pinned to the tail, so it is drawn last for as long
 * as the pin holds.
 *
 * The pinned child is the turn's running block. Rows appended below it (agent
 * cards, collaboration notices, queued output) keep landing after it in the
 * array — history order is never rewritten — but the running block still ends
 * up at the visible bottom, where a viewport following the end cannot leave it
 * behind. Unpinning drops the child back into its own slot, so a settled block
 * reads exactly like one that never moved.
 *
 * Invariants:
 * - The children array order is the transcript's source of truth; this class
 *   never mutates it. Only `render` consults the pin.
 * - The pin is a single slot: a component mounted below the pinned one must
 *   never be hidden, so only the tail moves.
 * - `render` is the sole consumer of the pin; callers that reorder or rebuild
 *   the container (clear) drop the pin instead of trusting it.
 */

import { type Component } from '@liutod-scream/pi-tui';

import { GutterContainer } from '../chrome/gutter-container';

export class LiveTailContainer extends GutterContainer {
  private pinned: Component | null = null;

  /**
   * Pins a child to the tail of the render order. A second call replaces the
   * previous pin — there is one live block per turn, so one slot is enough.
   */
  pinTail(child: Component): void {
    this.pinned = child;
  }

  /**
   * Releases the pin. Returns whether the visible row order moved, letting the
   * caller decide if a coordinate-based selection must be dropped: a pin whose
   * child is gone or already the last one changes nothing on screen.
   */
  unpinTail(child?: Component): boolean {
    const pinned = this.pinned;
    if (pinned === null) return false;
    if (child !== undefined && pinned !== child) return false;
    const index = this.children.indexOf(pinned);
    const moved = index !== -1 && index !== this.children.length - 1;
    this.pinned = null;
    return moved;
  }

  /** A cleared container has no children to reorder: drop the pin with them. */
  override clear(): void {
    super.clear();
    this.pinned = null;
  }

  protected override orderedChildren(): readonly Component[] {
    const pinned = this.pinned;
    if (pinned === null) return this.children;
    return [...this.children.filter((child) => child !== pinned), pinned];
  }
}
