/**
 * Silence ramp for the status-bar pulse wave.
 *
 * The wave reports one thing: how long the agent has been waiting on the model
 * without receiving anything. That covers a request awaiting its first token
 * and a reasoning or text stream that stopped delivering.
 *
 * A tool call in flight is exempt for its whole lifetime: a local process that
 * prints nothing is still working and its own timeout owns the outcome, and a
 * call whose arguments are still streaming in is the block the user is already
 * watching fill out — reddening the wave there reads as a false alarm rather
 * than as a stall report.
 *
 * Timeline (elapsed since the last inbound event, or since the request was
 * sent while no token has arrived yet):
 *   0 – 10s    brand green, nothing to report
 *   10 – 15s   green → yellow
 *   15 – 25s   yellow → deep red   (15s is pure yellow, 25s pure deep red)
 *   ≥ 25s      deep red
 *
 * The deep red is an early warning, not an error: retries are driven by real
 * transport failures (the stall timeout, disconnects, rate limits), never by
 * this colour.
 *
 * Colours come from the active palette (`primary` / `waveMid` / `wavePeak`),
 * so light and dark themes each ramp between their own contrast-checked
 * values and a theme switch takes effect on the next frame.
 */

import { lerpHex } from './gradient';

/** Green is held this long before the ramp starts. */
export const WAVE_GREEN_HOLD_MS = 10_000;
/** Pure yellow is reached here. */
export const WAVE_YELLOW_AT_MS = 15_000;
/** Pure deep red is reached here. */
export const WAVE_RED_AT_MS = 25_000;

export interface WaveColorStops {
  readonly green: string;
  readonly yellow: string;
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
  if (elapsedMs < WAVE_YELLOW_AT_MS) {
    return lerpHex(
      stops.green,
      stops.yellow,
      (elapsedMs - WAVE_GREEN_HOLD_MS) / (WAVE_YELLOW_AT_MS - WAVE_GREEN_HOLD_MS),
    );
  }
  if (elapsedMs < WAVE_RED_AT_MS) {
    return lerpHex(
      stops.yellow,
      stops.red,
      (elapsedMs - WAVE_YELLOW_AT_MS) / (WAVE_RED_AT_MS - WAVE_YELLOW_AT_MS),
    );
  }
  return stops.red;
}
