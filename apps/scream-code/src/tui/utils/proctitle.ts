/**
 * Terminal window title synchronization.
 *
 * Uses the session title when present, capped at 80 characters to keep tabs
 * readable. New or unnamed sessions fall back to `Scream Code`.
 *
 * Writes both `process.title`, for process listings, and OSC 0/2 escape
 * sequences, which most terminals use for window/tab titles. Non-TTY stdout
 * skips the OSC write.
 */
import { PRODUCT_NAME } from '#/constant/app';
import { MAX_PROCESS_TITLE_LENGTH } from '#/tui/constant/terminal';

export function setProcessTitle(title: string | null, _sessionId: string): void {
  const trimmed = title?.trim() ?? '';
  const label = trimmed.length > 0 ? trimmed.slice(0, MAX_PROCESS_TITLE_LENGTH) : PRODUCT_NAME;
  try {
    process.title = label;
  } catch {
    /* noop */
  }
  try {
    if (process.stdout.isTTY) {
      process.stdout.write(`\u001B]0;${label}\u0007`);
    }
  } catch {
    /* noop */
  }
}
