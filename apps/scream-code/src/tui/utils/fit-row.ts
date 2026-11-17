/**
 * Whole-item row fitting for the footer.
 *
 * A footer row is a LEFT group and a RIGHT group of items. When they do not
 * fit, items give way one whole step at a time instead of the row being cut in
 * the middle (which left half-words like `G…]` on screen):
 *
 *  - an item moves through its `variants` (longest first) — shrinking, and
 *  - once no shorter variant is left it is dropped whole, unless it is `keep`.
 *
 * Every step has a priority; the highest goes first. Shrinking and dropping
 * carry separate priorities so an item can shrink early (a long label becomes
 * a short one) yet be among the last to disappear. On a tie the item that comes
 * later in reading order (LEFT group first, then RIGHT) goes first, so the
 * leftmost item of a run is the last of the run to go.
 */

import { truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';

export interface FitItem {
  readonly id: string;
  /**
   * Priority of moving to the next (shorter) variant — one number, or one per
   * step (`[a, b]`: variant 0 → 1 at `a`, variant 1 → 2 at `b`). Higher goes
   * first.
   */
  readonly rank: number | readonly number[];
  /**
   * Priority of dropping the item once no shorter variant is left. Defaults to
   * `rank` (its last entry when `rank` is a list). Ignored when `keep` is set.
   */
  readonly dropRank?: number;
  /** Never dropped — it can only shrink. */
  readonly keep?: boolean;
  /** Already-styled renderings of the item, longest first. Must not be empty. */
  readonly variants: readonly string[];
}

export interface FitRowOptions {
  /** Columns between two items of the same group. Default 2. */
  readonly itemGap?: number;
  /** Minimum columns between the LEFT and the RIGHT group. Default 3. */
  readonly groupGap?: number;
}

interface Slot {
  readonly item: FitItem;
  readonly widths: readonly number[];
  step: number;
}

function stepRank(slot: Slot, canShrink: boolean): number {
  const { rank, dropRank } = slot.item;
  if (canShrink) {
    if (typeof rank === 'number') return rank;
    return rank[slot.step] ?? rank.at(-1) ?? 0;
  }
  if (dropRank !== undefined) return dropRank;
  return typeof rank === 'number' ? rank : (rank.at(-1) ?? 0);
}

/**
 * Lay `left` and `right` out on one row of exactly `width` columns: LEFT flush
 * left, RIGHT flush right, the gap filled with spaces. The result never
 * exceeds `width`; only when every remaining item is `keep` and still too wide
 * is the line hard-cut with an ellipsis as a last resort.
 */
export function fitRow(
  left: readonly FitItem[],
  right: readonly FitItem[],
  width: number,
  options: FitRowOptions = {},
): string {
  if (width <= 0) return '';
  const itemGap = options.itemGap ?? 2;
  const groupGap = options.groupGap ?? 3;

  const toSlots = (items: readonly FitItem[]): Slot[] =>
    items
      .filter((item) => item.variants.length > 0)
      .map((item) => ({ item, widths: item.variants.map((v) => visibleWidth(v)), step: 0 }));
  const lefts = toSlots(left);
  const rights = toSlots(right);

  const groupWidth = (group: readonly Slot[]): number =>
    group.reduce((sum, slot) => sum + (slot.widths[slot.step] ?? 0), 0) +
    itemGap * Math.max(0, group.length - 1);
  const total = (): number =>
    groupWidth(lefts) + groupWidth(rights) + (lefts.length > 0 && rights.length > 0 ? groupGap : 0);

  while (total() > width) {
    let victim: Slot | undefined;
    let victimGroup: Slot[] | undefined;
    let victimRank = Number.NEGATIVE_INFINITY;
    for (const group of [lefts, rights]) {
      for (const slot of group) {
        const canShrink = slot.step < slot.item.variants.length - 1;
        if (!canShrink && slot.item.keep === true) continue;
        const rank = stepRank(slot, canShrink);
        // `>=`: on a tie the later item in reading order goes first.
        if (rank >= victimRank) {
          victim = slot;
          victimGroup = group;
          victimRank = rank;
        }
      }
    }
    if (victim === undefined || victimGroup === undefined) break;
    if (victim.step < victim.item.variants.length - 1) victim.step += 1;
    else victimGroup.splice(victimGroup.indexOf(victim), 1);
  }

  const join = (group: readonly Slot[]): string =>
    group.map((slot) => slot.item.variants[slot.step] ?? '').join(' '.repeat(itemGap));
  const leftText = join(lefts);
  const rightText = join(rights);
  const gap = Math.max(0, width - visibleWidth(leftText) - visibleWidth(rightText));
  let line = leftText + ' '.repeat(gap) + rightText;
  if (visibleWidth(line) > width) line = truncateToWidth(line, width, '…');
  return line + ' '.repeat(Math.max(0, width - visibleWidth(line)));
}
