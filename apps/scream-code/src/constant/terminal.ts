// C0/control-sequence bytes used to build terminal protocol messages.
export const ESC = '\u001B';
export const BEL = '\u0007';
export const ST = '\\';

// ANSI cursor visibility toggles used by CLI prompts.
export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;
