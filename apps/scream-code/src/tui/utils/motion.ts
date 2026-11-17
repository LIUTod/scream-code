/**
 * Process-wide animation settings, so decorative motion has one switch and the
 * spinner cadence one knob instead of a literal in every component.
 *
 * Read at startup from the environment (`applyMotionEnv`):
 *   SCREAM_MOTION=off|0|false|none   no decorative animation at all
 *   SCREAM_REDUCED_MOTION=1|true|yes the same switch under its older name
 *   SCREAM_SPINNER_INTERVAL_MS=0     static spinners (frame 0, no timer)
 *   SCREAM_SPINNER_INTERVAL_MS=120   a different cadence (whole ms, >= 50)
 *
 * Either switch turns motion off; it is one setting, so every animated
 * component asks `motionEnabled()` (or `spinnerPeriodMs()` for spinners) and
 * none keeps a private switch. Information that merely changes over time — an
 * elapsed clock, a goal timer — is not decoration and keeps ticking.
 *
 * Useful on slow links (SSH), in screen recordings, and for people who do not
 * want moving text. An invalid value is ignored, never a startup failure.
 */

export const DEFAULT_SPINNER_INTERVAL_MS = 80;
export const MIN_SPINNER_INTERVAL_MS = 50;

let motion = true;
let reducedMotion = false;
let spinnerMs = DEFAULT_SPINNER_INTERVAL_MS;

/** False when either `SCREAM_MOTION` or `SCREAM_REDUCED_MOTION` asked for no motion. */
export function motionEnabled(): boolean {
  return motion && !reducedMotion;
}

/**
 * Whether a `SCREAM_REDUCED_MOTION` value requests reduced motion: `1`, `true`,
 * `yes` and any other non-empty value do; unset, empty, `0`, `false` and `no`
 * do not (case-insensitive).
 */
export function reducedMotionRequested(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  const lower = value.toLowerCase();
  return lower !== '0' && lower !== 'false' && lower !== 'no';
}

/** Spinner period, or `undefined` when spinners must stay still (motion off, or interval 0). */
export function spinnerPeriodMs(): number | undefined {
  return motionEnabled() && spinnerMs > 0 ? spinnerMs : undefined;
}

/** 0 (static) or a whole number of ms >= 50; anything else is `undefined`. */
export function parseSpinnerInterval(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const ms = Number(text);
  return ms === 0 || ms >= MIN_SPINNER_INTERVAL_MS ? ms : undefined;
}

const OFF_WORDS = new Set(['0', 'off', 'false', 'none']);

export function applyMotionEnv(env: Readonly<Record<string, string | undefined>>): void {
  const flag = env['SCREAM_MOTION']?.trim().toLowerCase();
  if (flag !== undefined && flag !== '') motion = !OFF_WORDS.has(flag);
  const reduced = env['SCREAM_REDUCED_MOTION'];
  if (reduced !== undefined && reduced !== '') reducedMotion = reducedMotionRequested(reduced);
  const interval = parseSpinnerInterval(env['SCREAM_SPINNER_INTERVAL_MS']);
  if (interval !== undefined) spinnerMs = interval;
}

/** Restore defaults (tests). */
export function resetMotion(): void {
  motion = true;
  reducedMotion = false;
  spinnerMs = DEFAULT_SPINNER_INTERVAL_MS;
}
