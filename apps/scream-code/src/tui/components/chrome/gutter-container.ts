/**
 * Container that reserves left/right gutter columns around its children,
 * so the chrome (statusline, transcript, panels) lines up with the input
 * box's inner content area instead of butting up against the terminal edge.
 *
 * Children are rendered at `width - left - right` and each emitted line is
 * prefixed with `left` plain spaces. Right padding is logical only — we
 * never emit trailing spaces, since terminals already paint background to
 * the edge and adding them would just churn the diff renderer.
 */

import { Container, type Component } from '@liutod-scream/pi-tui';

export class GutterContainer extends Container {
  constructor(
    private readonly leftPad: number,
    private readonly rightPad: number,
  ) {
    super();
  }

  override render(width: number): string[] {
    const inner = Math.max(1, width - this.leftPad - this.rightPad);
    const lead = ' '.repeat(this.leftPad);
    const out: string[] = [];
    for (const child of this.orderedChildren()) {
      for (const line of child.render(inner)) {
        out.push(lead + line);
      }
    }
    return out;
  }

  /**
   * The children in render order. Defaults to the array order; subclasses may
   * override this seam (the array itself stays the source of truth).
   */
  protected orderedChildren(): readonly Component[] {
    return this.children;
  }
}
