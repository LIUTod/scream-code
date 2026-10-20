/**
 * Silence ramp for the status-bar pulse wave.
 *
 * The wave reports one thing: how long the agent has been working without
 * receiving anything. That covers a request awaiting its first token, a
 * reasoning or text stream that stopped delivering, and a tool that has been
 * running without progress. Any inbound event resets the clock, so the wave
 * returns to the brand colour the moment work resumes.
 *
 * Timeline (elapsed since the last inbound event, or since the request was
 * sent while no token has arrived yet):
 *   0 – 10s    brand green, nothing to report
 *   10 – 15s   green → amber
 *   15 – 25s   amber → red      (15s is pure amber, 25s pure red)
 *   ≥ 25s      red
 *
 * Red is an early warning, not an error: retries are driven by real transport
 * failures (the stall timeout, disconnects, rate limits), never by this colour.
 *
 * Colours come from the active palette (primary / warning / error), so light
 * and dark themes each ramp between their own contrast-checked values and a
 * theme switch takes effect on the next frame.
 */

import { lerpHex } from './gradient';

/** Green is held this long before the ramp starts. */
export const WAVE_GREEN_HOLD_MS = 10_000;
/** Pure amber is reached here. */
export const WAVE_AMBER_AT_MS = 15_000;
/** Pure red is reached here. */
export const WAVE_RED_AT_MS = 25_000;

export interface WaveColorStops {
  readonly green: string;
  readonly amber: string;
  readonly red: string;
}

/**
 * Colour for a request that has been waiting `elapsedMs`.
 *
 * Non-finite or negative input falls back to green: a broken clock must never
 * make the indicator claim a stall.
 */
export function resolveWaveColor(elapsedMs: number, stops: WaveColorStops): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < WAVE_GREEN_HOLD_MS) return stops.green;
  if (elapsedMs < WAVE_AMBER_AT_MS) {
    return lerpHex(
      stops.green,
      stops.amber,
      (elapsedMs - WAVE_GREEN_HOLD_MS) / (WAVE_AMBER_AT_MS - WAVE_GREEN_HOLD_MS),
    );
  }
  if (elapsedMs < WAVE_RED_AT_MS) {
    return lerpHex(
      stops.amber,
      stops.red,
      (elapsedMs - WAVE_AMBER_AT_MS) / (WAVE_RED_AT_MS - WAVE_AMBER_AT_MS),
    );
  }
  return stops.red;
}
