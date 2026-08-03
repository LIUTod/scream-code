// U+25A0 solid square — stable monospace glyph, no emoji fallback risk.
export const STATUS_BULLET = '■ ';

// Shared transcript markers. Keep widths stable because message wrapping
// assumes the marker occupies the leading cells.
export const USER_MESSAGE_BULLET = '■ ';
export const FAILURE_MARK = '✗ ';

// Selector pointer used in lists, pickers, and queues.
export const SELECT_POINTER = '❯';

// Batch-select checkboxes used by pickers. U+25A1 / U+2611 are stable
// monospace glyphs with no emoji fallback risk (mirrors the STATUS_BULLET
// comment above).
export const CHECKBOX_OFF = '□';
export const CHECKBOX_ON = '☑';
