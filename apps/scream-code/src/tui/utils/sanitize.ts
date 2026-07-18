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
