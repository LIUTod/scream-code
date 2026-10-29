/**
 * Message dedup for the line daemon.
 *
 * Port of the reference `core/dedup.go` (MIT): Feishu's WebSocket delivery is
 * at-least-once — network jitter or an unacknowledged event makes the server
 * replay the same message. Track recently seen message IDs for a short TTL so
 * duplicates are dropped.
 */

/** Default dedup window: generous enough to absorb replay, bounded memory. */
export const DEFAULT_DEDUP_TTL_MS = 60_000;

export class MessageDedup {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_DEDUP_TTL_MS) {
    this.ttlMs = ttlMs > 0 ? ttlMs : DEFAULT_DEDUP_TTL_MS;
  }

  /** True when `id` was already seen within the TTL window. Empty ids never count. */
  isDuplicate(id: string): boolean {
    if (!id) return false;
    const now = Date.now();
    const seenAt = this.seen.get(id);
    if (seenAt !== undefined && now - seenAt < this.ttlMs) {
      return true;
    }
    // First sighting or expired entry — record and prune in the same pass so
    // the map stays bounded under steady traffic.
    this.seen.set(id, now);
    for (const [key, at] of this.seen) {
      if (now - at >= this.ttlMs) this.seen.delete(key);
    }
    return false;
  }

  /** Number of entries currently tracked (expired entries pruned first). */
  size(): number {
    const now = Date.now();
    for (const [key, at] of this.seen) {
      if (now - at >= this.ttlMs) this.seen.delete(key);
    }
    return this.seen.size;
  }
}
