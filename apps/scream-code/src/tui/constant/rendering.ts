// Continuation indent for transcript rows that use a two-cell leading marker.
export const MESSAGE_INDENT = '  ';

// Outer left/right padding applied to the transcript, panels, and the
// statusline so the chrome's left edge lines up with the input box's
// interior (the `>` prompt). The editor itself stays at column 0 — its
// vertical borders are the visual anchor everything else aligns against.
export const CHROME_GUTTER = 1;

// Shared preview caps used by thinking, tool results, and shell snippets.
export const RESULT_PREVIEW_LINES = 3;
export const THINKING_PREVIEW_LINES = 2;
export const COMMAND_PREVIEW_LINES = 10;

// Collapsed shell cards keep the command visible (so the user can always see
// what ran) but cap it at this many lines; ctrl+o reveals the full command.
export const SHELL_COMMAND_COLLAPSED_LINES = 3;

// Tail-preview cap for tool/shell output. Outputs longer than this default to
// a collapsed TAIL preview (newest lines - where command errors land) with an
// expand hint at the top, so a long command result no longer explodes the
// transcript. Larger than RESULT_PREVIEW_LINES so the preview stays useful.
export const TOOL_OUTPUT_PREVIEW_LINES = 15;

// Shell output is capped before wrapping to prevent a single huge command
// result from hanging the renderer.
export const MAX_SHELL_OUTPUT_BYTES = 128 * 1024;

// Activity group: a turn's reasoning plus its tool calls collapsed into a
// single block. The expanded tree previews this many result lines per tool and
// this many reasoning lines.
export const ACTIVITY_GROUP_TOOL_PREVIEW_LINES = 3;
// Rows of a collapsed block, header included: the header plus this many minus
// one steps of the timeline (reasoning runs, tool calls and the inline edit
// previews share the budget, newest kept; the newest four steps keep their own
// rows first). Fourteen leaves room for those steps and a full edit preview;
// at three rows the block only ever showed its header plus a single step.
export const ACTIVITY_GROUP_COLLAPSED_LINES = 14;
// Changed lines shown under each Edit/Write row while a block is folded
// (`/blockrows`; 0 turns the inline preview off). The rest is counted.
export const ACTIVITY_GROUP_EDIT_PREVIEW_LINES = 12;
// Result lines previewed per tool once the group is expanded (`/blockrows`;
// the whole result stays one Ctrl+O away on the card itself).
export const ACTIVITY_GROUP_TOOL_EXPANDED_LINES = 10;
// Block-level ceiling for the expanded tree. A turn with dozens of tools would
// otherwise expand to hundreds of rows; the tools that do not fit are summarised
// in a single "N more tools" row.
export const ACTIVITY_GROUP_EXPANDED_LINES = 60;
// Defaults for the three budgets `/blockrows` can override at runtime; the block
// reads them through `utils/activity-lines.ts`, never directly.
export const ACTIVITY_GROUP_THINKING_EXCERPT_LINES = 10;

// Animation frames are shared by update loaders and live thinking.
export const BRAILLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const BRAILLE_SPINNER_INTERVAL_MS = 80;

// Breathing pixel block: selection indicator pulse (approval panel choices).
// Single-cell width so the layout never shifts between frames.
export const PIXEL_PULSE_FRAMES = ['█', '▓', '▒', '░', '▒', '▓'];
export const PIXEL_PULSE_INTERVAL_MS = 100;

// Pulse-wave animation: 8-box flowing indicator.
// Each frame defines which box is "active" (full colour) and the wave's direction.
// Forward  → the active box is the leading edge, previous box is trailing.
// Backward → the active box is the leading edge moving left.
// The wave runs to the last box and bounces back (ping-pong) so the loop
// never jumps.
export const PULSE_WAVE_CELLS = 8;
const forwardFrames = Array.from({ length: PULSE_WAVE_CELLS }, (_, active) => ({ active, forward: true }));
const backwardFrames = Array.from({ length: PULSE_WAVE_CELLS - 2 }, (_, i) => ({
  active: PULSE_WAVE_CELLS - 2 - i,
  forward: false,
}));
export const PULSE_WAVE_FRAMES = [...forwardFrames, ...backwardFrames];
export const PULSE_WAVE_INTERVAL_MS = 80;

// Rows the dock keeps below the transcript: the status row above the editor
// keeps one row even when it renders nothing (a minSize 0 would let the dock's
// shrink pass squeeze it away), and the footer renders exactly one row.
// Panels that replace the editor size themselves against what is left.
export const DOCK_STATUS_ROWS = 1;
// The footer is one row at every terminal size; the status row above the editor
// is drawn at every width too, so the footer never has to carry the work state.
export const DOCK_FOOTER_ROWS = 1;
// Transcript rows a replacement panel leaves visible above itself: the last
// message, so the person still sees what is being decided on.
export const PANEL_MIN_TRANSCRIPT_ROWS = 1;
// The todo panel above the editor is drawn from this terminal width up.
export const TODO_PANEL_MIN_WIDTH = 90;
