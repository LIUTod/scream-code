/**
 * Terminal window title synchronization.
 *
 * Uses the session title when present, capped at 80 characters to keep tabs
 * readable. New or unnamed sessions fall back to `Scream Code`.
 *
 * Writes both `process.title`, for process listings, and OSC 0/2 escape
 * sequences, which most terminals use for window/tab titles. Non-TTY stdout
 * skips the OSC write. `prefix` (what the session is doing, see
 * `terminal-title.ts`) goes on the terminal's title only, never on the
 * process name.
 */
import { PRODUCT_NAME } from '#/constant/app';
import { MAX_PROCESS_TITLE_LENGTH } from '#/tui/constant/terminal';

export function setProcessTitle(title: string | null, _sessionId: string, prefix: string = ''): void {
  const trimmed = title?.trim() ?? '';
  const label = trimmed.length > 0 ? trimmed.slice(0, MAX_PROCESS_TITLE_LENGTH) : PRODUCT_NAME;
  try {
    process.title = label;
  } catch {
    /* noop */
  }
  try {
    if (process.stdout.isTTY) {
      process.stdout.write(`\u001B]0;${prefix}${label}\u0007`);
    }
  } catch {
    /* noop */
  }
}
