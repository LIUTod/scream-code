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

import { Container } from '@liutod-scream/pi-tui';

/**
 * OSC 133 zone markers at the head of a row ("a prompt starts here"). The
 * terminal view reads them from the very start of the row to jump between
 * prompts, so the gutter goes after them, not before.
 */
const ZONE_MARKERS = /^(?:\u001B\]133;[ABC](?:\u0007|\u001B\\))+/;

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
    for (const child of this.children) {
      for (const line of child.render(inner)) {
        const markers = ZONE_MARKERS.exec(line)?.[0] ?? '';
        out.push(markers + lead + line.slice(markers.length));
      }
    }
    return out;
  }
}
