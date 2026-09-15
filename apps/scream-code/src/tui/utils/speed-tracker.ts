/**
 * Streaming-speed gauge for the live thinking indicator.
 *
 * The provider does not report cumulative token counts during streaming (only
 * character deltas), so instantaneous tok/s is estimated from the delta text
 * via {@link estimateTokens}. The badge is a progress indicator, not a precise
 * meter.
 */

/** Rolling window (ms) over which streaming-rate observations are averaged. */
export const SPEED_WINDOW_MS = 3000;
/** Color ceiling: a rate at or above this maps to the full accent color. The
 *  displayed tok/s is NOT clamped — it keeps rising past this value; only the
 *  color gauge saturates here. */
export const SPEED_MAX = 200;
/** First codepoint of the CJK ranges (radicals and above): one token per char. */
const CJK_START = 0x2e80;
/** Latin/digit/punctuation average, matching the ~4 chars/token rule of thumb. */
const LATIN_CHARS_PER_TOKEN = 4;

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
export function estimateTokens(text: string): number {
  let cjk = 0;
  let latin = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) >= CJK_START) cjk += 1;
    else latin += 1;
  }
  return Math.max(1, Math.round(cjk + latin / LATIN_CHARS_PER_TOKEN));
}

/**
 * Number of leading characters of `text` that fit into a token budget, using
 * the same script-aware basis as {@link estimateTokens}. Smooth-rendering paces
 * by a token budget, so converting it back to characters has to use this
 * estimator instead of a single chars-per-token constant.
 */
export function charsForTokenBudget(text: string, tokenBudget: number): number {
  let cjk = 0;
  let latin = 0;
  let chars = 0;
  for (const char of text) {
    const isCjk = (char.codePointAt(0) ?? 0) >= CJK_START;
    const nextCjk = cjk + (isCjk ? 1 : 0);
    const nextLatin = latin + (isCjk ? 0 : 1);
    if (nextCjk + nextLatin / LATIN_CHARS_PER_TOKEN > tokenBudget) break;
    cjk = nextCjk;
    latin = nextLatin;
    chars += 1;
  }
  return chars;
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
