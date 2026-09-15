import type { CSSProperties } from 'vue';

/**
 * Shared positioning math for fixed-position popovers.
 *
 * MenuPopover and ModelPicker need the same placement: after the popover is teleported to
 * body it is positioned with fixed coordinates against the trigger's viewport rect, dodging
 * clipping by ancestor overflow scroll containers (the composer chip row and the sidebar list
 * are both scroll containers; an absolute popover would be clipped away entirely). The
 * algorithm was lifted verbatim from MenuPopover's existing implementation — carrying two
 * copies would inevitably let parameters like gap/edge drift apart.
 */
export interface PopoverPlacement {
  /** Whether the popover sits above or below the anchor. */
  placement: 'top' | 'bottom';
  /** Which anchor edge the popover aligns to. */
  align: 'left' | 'right';
  /** Max width (px); when left-aligned it also serves as the width estimate for overflow clamping. */
  maxWidth: number;
  /** Gap between the popover and the anchor, default 6. */
  gap?: number;
  /** Minimum distance to the viewport edge, default 8. */
  edge?: number;
}

/** Computes the fixed-position style from the anchor rect; clamps back inside the viewport when overflowing horizontally. */
export function computePopoverStyle(anchor: DOMRect, opts: PopoverPlacement): CSSProperties {
  const gap = opts.gap ?? 6;
  const edge = opts.edge ?? 8;
  const style: CSSProperties = { position: 'fixed', maxWidth: `${opts.maxWidth}px` };
  if (opts.placement === 'top') style.bottom = `${window.innerHeight - anchor.top + gap}px`;
  else style.top = `${anchor.bottom + gap}px`;
  if (opts.align === 'right') {
    style.right = `${Math.max(edge, window.innerWidth - anchor.right)}px`;
  } else {
    style.left = `${Math.min(
      Math.max(edge, anchor.left),
      Math.max(edge, window.innerWidth - opts.maxWidth - edge),
    )}px`;
  }
  return style;
}
