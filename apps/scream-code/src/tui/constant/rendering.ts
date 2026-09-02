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
