/**
 * Rotating pool of provider API keys.
 *
 * A provider configured with several credentials (quota-split accounts, a
 * primary plus a backup) exposes them as an array; the adapter holds a
 * {@link KeyRing} over that array and swaps to the next usable key when the
 * current one is rejected with a quota-style 429.
 *
 * Semantics:
 * - Keys keep insertion order; blank/whitespace entries are dropped and
 *   duplicates collapse to their first occurrence (a duplicated key offers no
 *   rotation).
 * - `startIndex` gives a per-session *affinity*: sessions spread their first
 *   request across the pool instead of all hammering key #1.
 * - Cooldowns are advisory, not a hard exclusion: a cooled key is skipped
 *   while another key is usable, and the ring falls back to the cursor key
 *   when every key is cooling down — a fully-cooled ring must never leave a
 *   provider without a credential.
 */
export interface KeyRing {
  /** Next usable key: the cursor key, or the next non-cooled one after it. */
  current(): string | undefined;
  /**
   * Advance the cursor to the next usable key (round-robin, skipping cooled
   * keys). Returns `false` only when every key is cooled — i.e. when there is
   * nowhere to move to.
   */
  rotate(): boolean;
  /** Hold `key` out of rotation for `ms` milliseconds. Unknown keys are ignored. */
  markCooldown(key: string, ms: number): void;
  /** Number of keys in the ring (blank entries excluded). */
  size(): number;
}

export interface KeyRingOptions {
  /** Affinity offset (clamped modulo the pool size). Defaults to 0. */
  readonly startIndex?: number;
  /** Clock override, for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Cooldown applied to a key that just failed a rotation: a quota-style 429
 * clears within a minute on per-minute windows, so 30s keeps the key out of
 * the immediate retry while letting it back in for later requests.
 */
export const API_KEY_COOLDOWN_MS = 30_000;

export function createKeyRing(keys: readonly string[], options: KeyRingOptions = {}): KeyRing {
  const pool: string[] = [];
  for (const raw of keys) {
    const key = raw.trim();
    if (key.length === 0 || pool.includes(key)) continue;
    pool.push(key);
  }

  const count = pool.length;
  const cooldowns = new Map<string, number>();
  const now = options.now ?? (() => Date.now());
  let cursor = count === 0 ? 0 : normalizeIndex(options.startIndex ?? 0, count);

  const isCooled = (key: string): boolean => {
    const until = cooldowns.get(key);
    if (until === undefined) return false;
    if (until <= now()) {
      cooldowns.delete(key);
      return false;
    }
    return true;
  };

  return {
    current(): string | undefined {
      if (count === 0) return undefined;
      if (!isCooled(pool[cursor]!)) return pool[cursor];
      for (let step = 1; step <= count; step += 1) {
        const index = (cursor + step) % count;
        const key = pool[index]!;
        if (!isCooled(key)) {
          cursor = index;
          return key;
        }
      }
      return pool[cursor];
    },
    rotate(): boolean {
      if (count === 0) return false;
      // Start strictly after the cursor and wrap, so a cooled cursor key is
      // skipped in favour of the next usable neighbour.
      for (let step = 1; step <= count; step += 1) {
        const index = (cursor + step) % count;
        const key = pool[index]!;
        if (!isCooled(key)) {
          cursor = index;
          return true;
        }
      }
      return false;
    },
    markCooldown(key: string, ms: number): void {
      const normalized = key.trim();
      if (ms <= 0 || !pool.includes(normalized)) return;
      cooldowns.set(normalized, now() + ms);
    },
    size(): number {
      return count;
    },
  };
}

function normalizeIndex(index: number, count: number): number {
  const truncated = Number.isFinite(index) ? Math.trunc(index) : 0;
  return ((truncated % count) + count) % count;
}

/**
 * Normalize a configured credential into the array a {@link KeyRing} expects:
 * a single key becomes a one-entry pool, an array passes through, unset stays
 * empty.
 */
export function resolveApiKeys(configured: string | string[] | undefined): string[] {
  if (configured === undefined) return [];
  return Array.isArray(configured) ? [...configured] : [configured];
}
