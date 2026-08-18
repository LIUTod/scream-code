import { truncateToWidth } from '@liutod-scream/pi-tui';
import * as os from 'node:os';

/** Replace tabs with spaces, keeping column alignment. Default tab width 4. */
export function replaceTabs(text: string, tabWidth = 4): string {
  return text.replaceAll('	', ' '.repeat(tabWidth));
}

/** Replace the home directory prefix with ~. */
export function shortenPath(fullPath: string): string {
  const home = os.homedir();
  if (fullPath === home || fullPath.startsWith(home + '/')) {
    return '~' + fullPath.slice(home.length);
  }
  return fullPath;
}

/** Shared truncation length constants — no ad-hoc numbers in render paths. */
export const TRUNCATE_LENGTHS = {
  /** Approval panel file content previews */
  FILE_CONTENT: 300,
  /** Error messages (may embed file content) */
  ERROR: 200,
  /** Notice / informational text */
  NOTICE: 120,
  /** Status bar / one-liners */
  STATUS: 80,
} as const;

/**
 * Sanitize a single line for terminal rendering: replace tabs, truncate to width.
 * Returns the sanitized string.
 */
export function sanitizeLine(line: string, maxWidth: number): string {
  return truncateToWidth(replaceTabs(line), maxWidth);
}

/**
 * Sanitize multi-line text for terminal rendering:
 * replace tabs in every line, truncate each to maxWidth.
 * Returns an array of sanitized lines.
 */
export function sanitizeLines(text: string, maxWidth: number): string[] {
  return text.split('\n').map((line) => sanitizeLine(line, maxWidth));
}

/**
 * Strip terminal control characters from untrusted shell output before it is
 * rendered inside a framed pane. Carriage returns (progress-bar redraws) and
 * ANSI escape sequences (cursor moves, screen clears, SGR color codes, OSC
 * title/OSC 52 clipboard sequences, charset selection) would otherwise disrupt
 * the terminal borders or let task output inject escape sequences. All
 * printable text is preserved.
 */
export function sanitizeShellOutput(output: string): string {
  return output
    .replaceAll('\r', '')
    // CSI: ESC [ params? intermediates? final-byte (0x40-0x7E)
    .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    // OSC: ESC ] ... (BEL or ST)
    .replaceAll(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    // DCS / PM / APC: ESC P | ^ | _ ... (BEL or ST)
    .replaceAll(/\u001B[P^_][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    // Charset selection: ESC ( / ESC ) + charset
    .replaceAll(/\u001B[()][0-9A-Za-z]/g, '')
    // Single-char selectors: ESC > / ESC = / ESC 7 / ESC 8 / ESC D ...
    .replaceAll(/\u001B[=>78DEFHMc]/g, '');
}
