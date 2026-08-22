/**
 * Streaming-speed gauge for the live thinking indicator.
 *
 * Ported from oh-my-pi `packages/coding-agent/src/modes/components/assistant-message.ts:120-178`.
 * scream-code adaptation: the provider does not report cumulative token counts
 * during streaming (only character deltas), so instantaneous tok/s is estimated
 * from delta length via {@link CHARS_PER_TOKEN_ESTIMATE}. The badge is a progress
 * indicator, not a precise meter.
 */

/** Rolling window (ms) over which streaming-rate observations are averaged. */
export const SPEED_WINDOW_MS = 3000;
/** Color ceiling: a rate at or above this maps to the full accent color. The
 *  displayed tok/s is NOT clamped — it keeps rising past this value; only the
 *  color gauge saturates here. */
export const SPEED_MAX = 200;
/**
 * Chars-per-token estimate for converting character deltas to an approximate
 * token count. 2.5 is a middle ground between English (~4 chars/token) and
 * Chinese (~1 char/token). Pure Chinese underestimates ~2.5x, pure English
 * overestimates ~1.6x — acceptable for a progress indicator.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 2.5;

interface SpeedObservation {
  readonly time: number;
  readonly tokens: number;
  readonly elapsedMs: number;
}

export class SpeedTracker {
  private observations: SpeedObservation[] = [];

  private prune(now: number): void {
    const threshold = now - SPEED_WINDOW_MS;
    while (this.observations.length > 0 && this.observations[0]!.time < threshold) {
      this.observations.shift();
    }
  }

  /**
   * Record one delta: the estimated tokens it carried and the elapsed ms since
   * the previous delta. Non-finite/negative values are ignored. The windowed
   * figure in {@link getSpeed} is `Σtokens / Σelapsed` (the standard
   * "generation speed"), which is robust to bursty arrivals and needs no
   * clamping.
   */
  observe(tokens: number, elapsedMs: number, now: number = performance.now()): void {
    if (!Number.isFinite(tokens) || tokens < 0) return;
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
    // A gap larger than the window is a network/load stall, not a generation
    // rate: the first delta after it carries a huge elapsed that would poison
    // Σelapsed and read as a false slow-down. Drop it and let the window
    // re-establish from the next contiguous delta.
    if (elapsedMs > SPEED_WINDOW_MS) return;
    this.observations.push({ time: now, tokens, elapsedMs });
    this.prune(now);
  }

  /**
   * Windowed generation speed = Σtokens / Σseconds over the 3s rolling
   * window. This is the "pure generation speed" measure: a single delta's
   * sudden burst of tokens is counted honestly (it genuinely arrived in that
   * window), while a near-zero-interval artifact no longer produces an
   * implausible instantaneous figure. Observations whose gap exceeds the
   * window (network/load stalls) are dropped so they don't read as a false
   * slow-down. 0 once the window empties.
   */
  getSpeed(now: number = performance.now()): number {
    this.prune(now);
    if (this.observations.length === 0) return 0;
    let totalTokens = 0;
    let totalElapsedMs = 0;
    for (const o of this.observations) {
      totalTokens += o.tokens;
      totalElapsedMs += o.elapsedMs;
    }
    if (totalElapsedMs <= 0) return 0;
    return (totalTokens / totalElapsedMs) * 1000;
  }

  reset(): void {
    this.observations = [];
  }
}

/**
 * One gauge for the whole session. Only the single live thinking block feeds it
 * (via {@link StreamingUIController.appendThinkingDelta} / {@link appendAssistantDelta}),
 * and only the live {@link ThinkingComponent} reads it. Reset on turn boundaries
 * so a previous turn's trailing rate doesn't leak onto a fresh block.
 */
const sharedSpeedTracker = new SpeedTracker();

export function getSharedSpeedTracker(): SpeedTracker {
  return sharedSpeedTracker;
}

/** Test-only: clear the shared gauge so observations don't leak across cases. */
export function resetSharedSpeedTracker(): void {
  sharedSpeedTracker.reset();
}

/**
 * Linear-interpolate two `#rrggbb` colors in sRGB space. `t` clamps to [0,1]:
 * `t = 0` → `from`, `t = 1` → `to`. Drives the streaming speed badge, fading
 * from a dim gray toward the theme accent as tok/s rises.
 */
export function lerpHex(from: string, to: string, t: number): string {
  const k = t < 0 ? 0 : Math.min(1, t);
  const fr = Number.parseInt(from.slice(1, 3), 16);
  const fg = Number.parseInt(from.slice(3, 5), 16);
  const fb = Number.parseInt(from.slice(5, 7), 16);
  const tr = Number.parseInt(to.slice(1, 3), 16);
  const tg = Number.parseInt(to.slice(3, 5), 16);
  const tb = Number.parseInt(to.slice(5, 7), 16);
  const r = Math.round(fr + (tr - fr) * k);
  const g = Math.round(fg + (tg - fg) * k);
  const b = Math.round(fb + (tb - fb) * k);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

/**
 * Estimate token count from a character delta. At least 1 to avoid zero-rate
 * observations when a tiny delta arrives.
 */
export function estimateTokens(delta: string): number {
  return Math.max(1, Math.round(delta.length / CHARS_PER_TOKEN_ESTIMATE));
}

/**
 * Ease the normalized speed ratio [0,1] for color interpolation. Uses smoothstep
 * (zero derivative at both endpoints) so the badge stays mostly gray at low
 * rates — subtle rather than distracting — and only reaches the full accent
 * color at high rates. Smoother than sqrt, whose infinite derivative at t=0
 * makes the color jump toward accent as soon as any tokens flow.
 */
export function easeSpeedRatio(ratio: number): number {
  const t = ratio < 0 ? 0 : Math.min(1, ratio);
  return t * t * (3 - 2 * t);
}
