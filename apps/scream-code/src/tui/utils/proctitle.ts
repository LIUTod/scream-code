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

/**
 * The title goes into an escape sequence, and a session title can come from the
 * model: a BEL or an ESC in it would end the sequence early and let the rest
 * act as terminal commands. Control characters (C0, DEL and C1) become spaces.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

export function setProcessTitle(title: string | null, _sessionId: string, prefix: string = ''): void {
  const trimmed = (title ?? '').replaceAll(CONTROL_CHARACTERS, ' ').trim();
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
