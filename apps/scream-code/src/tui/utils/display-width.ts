import { visibleWidth } from '@liutod-scream/pi-tui';

/** Display-column width of a string, matching the terminal layout engine
 *  (ANSI sequences stripped, CJK/wide chars counted as 2 columns). */
export function displayWidth(text: string): number {
  return visibleWidth(text);
}
