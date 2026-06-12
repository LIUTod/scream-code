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

// Shell output is capped before wrapping to prevent a single huge command
// result from hanging the renderer.
export const MAX_SHELL_OUTPUT_BYTES = 128 * 1024;

// Animation frames are shared by update loaders and live thinking.
export const BRAILLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const BRAILLE_SPINNER_INTERVAL_MS = 80;

export const MOON_SPINNER_FRAMES = ['💬', '🗯️', '🫯', '💭', '💬', '🗯️', '🫯', '💭'];
export const MOON_SPINNER_INTERVAL_MS = 120;

// Pulse-wave animation: 3-box breathing indicator à la Grok's PromptLoadingBoxes.
// Each frame defines which box is "active" (full colour) and the wave's direction.
// Forward  → the active box is the leading edge, previous box is trailing.
// Backward → the active box is the leading edge moving left.
export const PULSE_WAVE_FRAMES = [
  { active: 0, forward: true },
  { active: 1, forward: true },
  { active: 2, forward: true },
  { active: 1, forward: false },
] as const;
export const PULSE_WAVE_INTERVAL_MS = 120;
