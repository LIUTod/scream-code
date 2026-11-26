/**
 * A confirmation that only matters for a moment — "copied", "highlight on",
 * "cancelled" — goes to the terminal view's toast, not into the transcript:
 * the toast clears itself, so a long session is not littered with lines that
 * said something once. What a person may need to read again, and every error
 * and warning, stays a transcript row (`showStatus`).
 *
 * A host that cannot show a toast (a test, a view without one) gets the
 * transcript row instead, so nothing is lost.
 */

/** How long a toast stays: long enough to read a short sentence. */
export const FLASH_STATUS_MS = 2200;

export interface FlashStatusHost {
  showStatus(message: string, color?: string): void;
  flash?: ((message: string) => void) | undefined;
}

export function flashStatus(host: FlashStatusHost, message: string, color?: string): void {
  if (host.flash !== undefined) host.flash(message);
  else if (color === undefined) host.showStatus(message);
  else host.showStatus(message, color);
}
