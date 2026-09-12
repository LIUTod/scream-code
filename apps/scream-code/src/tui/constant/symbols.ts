// U+25A0 solid square — stable monospace glyph, no emoji fallback risk.
export const STATUS_BULLET = '■ ';

// Shared transcript markers. Keep widths stable because message wrapping
// assumes the marker occupies the leading cells.
export const USER_MESSAGE_BULLET = '■ ';
export const FAILURE_MARK = '✗ ';

// U+25B8 small right triangle — marks an interjection row: a subagent cutting
// into the main transcript to speak up. The square stays reserved for user and
// assistant speech. Text-presentation only (unlike U+25B6, which terminals may
// render as a 2-cell emoji) and one cell wide, so the two-cell marker column
// keeps aligning with `■ ` / `✗ `.
export const INTERJECTION_BULLET = '▸ ';

// Selector pointer used in lists, pickers, and queues.
export const SELECT_POINTER = '❯';

// Batch-select checkboxes used by pickers. U+25A1 / U+2611 are stable
// monospace glyphs with no emoji fallback risk (mirrors the STATUS_BULLET
// comment above).
export const CHECKBOX_OFF = '□';
export const CHECKBOX_ON = '☑';
