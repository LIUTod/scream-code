/**
 * Shared breathing clock — single source of truth for the breathing
 * animation frame across all chrome components (welcome panel, editor
 * border, loading splash).
 *
 * Before this module each component ran its own `setInterval` + local
 * frame counter. Because they started at different times (welcome at
 * construction, editor only after the user clears the input) and the
 * editor reset its counter to 0 on every stop/start, the two gradients
 * were always offset by a fixed hue angle and the editor's border
 * visibly "jumped back to the start" whenever the user typed and
 * cleared the input.
 *
 * This module exposes a pure `getBreathingFrame()` based on wall-clock
 * time, so every consumer reads the same value at the same instant.
 * The per-component `setInterval` is still used to drive
 * `requestRender()`, but the frame value is no longer local state.
 */

export const BREATHE_STEPS = 120;
export const BREATHE_INTERVAL_MS = 40;

const startTime = Date.now();

export function getBreathingFrame(): number {
  return Math.floor((Date.now() - startTime) / BREATHE_INTERVAL_MS) % BREATHE_STEPS;
}
