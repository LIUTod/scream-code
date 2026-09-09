import { visibleWidth } from '@liutod-scream/pi-tui';

/** Display-column width of a string, matching the terminal layout engine
 *  (ANSI sequences stripped, CJK/wide chars counted as 2 columns). */
export function displayWidth(text: string): number {
  return visibleWidth(text);
}

/** Pad `label` to `target` display columns with spaces (CJK-aware). */
export function padLabel(label: string, target: number): string {
  return label + ' '.repeat(Math.max(0, target - displayWidth(label)));
}
