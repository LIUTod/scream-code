/**
 * Minimal in-memory fixed-window rate limiter (per key, e.g. client IP).
 *
 * Used to throttle gateway login attempts. State is per-process; a server
 * restart clears all windows, which is acceptable for a single-user local
 * service. Entries are pruned opportunistically once the map grows.
 */

export interface FixedWindowLimiter {
  /**
   * Records one attempt. Returns whether the caller may proceed; when
   * blocked, `retryAfterSeconds` reports when the current window expires.
   */
  hit(key: string): { ok: boolean; retryAfterSeconds: number };
  /** Clears the counter for a key (e.g. after a successful login). */
  reset(key: string): void;
}

export function createFixedWindowLimiter(opts: { windowMs: number; max: number }): FixedWindowLimiter {
  const { windowMs, max } = opts;
  const windows = new Map<string, { start: number; count: number }>();

  return {
    hit(key) {
      const now = Date.now();
      const entry = windows.get(key);
      if (entry === undefined || now - entry.start >= windowMs) {
        windows.set(key, { start: now, count: 1 });
        if (windows.size > 1024) {
          for (const [k, e] of windows) {
            if (now - e.start >= windowMs) windows.delete(k);
          }
        }
        return { ok: true, retryAfterSeconds: 0 };
      }
      entry.count += 1;
      if (entry.count > max) {
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000)) };
      }
      return { ok: true, retryAfterSeconds: 0 };
    },
    reset(key) {
      windows.delete(key);
    },
  };
}
