/**
 * Adaptive width tiering for terminal layout.
 *
 * Components that need to degrade at narrow widths should branch on
 * `widthTier(width)` instead of hardcoding magic thresholds. The four tiers
 * match common terminal breakpoints:
 *
 *   - `tiny`   (< 58):  single-column, no gutters, bare badge
 *   - `narrow` (58–79): no decorative padding, lean status
 *   - `medium` (80–99): full content, no secondary columns
 *   - `full`   (≥ 100): everything fits
 *
 * Thresholds are chosen so that:
 *   - `tiny` covers the minimum width where a tool-call header
 *     (`■ 已使用 Read (foo.ts)`) still fits on one line
 *   - `narrow` is the range where most content fits but chrome (gutters,
 *     badges) competes with body text
 *   - `medium` is the comfortable single-pane range
 *   - `full` allows side panels / multi-column layouts
 *
 * Existing components (welcome.ts, footer.ts) already have their own
 * ad-hoc thresholds; `widthTier` is provided as the canonical primitive for
 * new components so the breakpoints stay consistent.
 */

export type LayoutTier = 'tiny' | 'narrow' | 'medium' | 'full';

export function widthTier(width: number): LayoutTier {
  if (width >= 100) return 'full';
  if (width >= 80) return 'medium';
  if (width >= 58) return 'narrow';
  return 'tiny';
}
