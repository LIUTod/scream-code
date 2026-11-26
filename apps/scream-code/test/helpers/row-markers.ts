/**
 * The invisible row markers the terminal view reads to copy faithfully (where a
 * row's own text starts, that a row continues the one above, that a row is
 * decoration all through). They are zero-width, so a test that compares row
 * text drops them first.
 */

/** Content start (9911), hidden row (9913) and soft wrap (9912;gap), either terminator. */
export const ROW_MARKERS = /\u001B\](?:9911|9913|9912;\d+)(?:\u0007|\u001B\\)/g;

/** The marker a row carries where its decoration ends. */
export const CONTENT_START = '\u001B]9911\u0007';

export function withoutRowMarkers(text: string): string {
  return text.replaceAll(ROW_MARKERS, '');
}
