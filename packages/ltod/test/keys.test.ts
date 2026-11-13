import { describe, expect, it } from 'vitest';

import { API_KEY_COOLDOWN_MS, createKeyRing } from '#/keys';

describe('createKeyRing', () => {
  it('keeps insertion order and exposes the pool size', () => {
    const ring = createKeyRing(['key-1', 'key-2', 'key-3']);
    expect(ring.size()).toBe(3);
    expect(ring.current()).toBe('key-1');
  });

  it('drops blank entries and collapses duplicates', () => {
    const ring = createKeyRing(['', ' key-1 ', 'key-2', 'key-1', '   ']);
    expect(ring.size()).toBe(2);
    expect(ring.current()).toBe('key-1');
  });

  it('is empty when nothing usable is configured', () => {
    const ring = createKeyRing(['', ' ']);
    expect(ring.size()).toBe(0);
    expect(ring.current()).toBeUndefined();
    expect(ring.rotate()).toBe(false);
  });

  it('honours the affinity start index', () => {
    expect(createKeyRing(['a', 'b', 'c'], { startIndex: 2 }).current()).toBe('c');
    // Clamped modulo the pool size in both directions.
    expect(createKeyRing(['a', 'b', 'c'], { startIndex: 4 }).current()).toBe('b');
    expect(createKeyRing(['a', 'b', 'c'], { startIndex: -1 }).current()).toBe('c');
  });

  it('rotates round-robin and wraps', () => {
    const ring = createKeyRing(['a', 'b', 'c']);
    expect(ring.rotate()).toBe(true);
    expect(ring.current()).toBe('b');
    expect(ring.rotate()).toBe(true);
    expect(ring.current()).toBe('c');
    expect(ring.rotate()).toBe(true);
    expect(ring.current()).toBe('a');
  });

  it('skips a cooled key and comes back to it after the cooldown expires', () => {
    let now = 1_000;
    const ring = createKeyRing(['a', 'b', 'c'], { now: () => now });

    ring.rotate(); // → b
    ring.markCooldown('b', 30_000);
    expect(ring.current()).toBe('c');

    ring.rotate(); // c → a (b is cooling, skipped)
    expect(ring.current()).toBe('a');

    now += 30_001;
    ring.rotate(); // a → b is usable again
    expect(ring.current()).toBe('b');
  });

  it('returns false from rotate() when every key is cooled', () => {
    const ring = createKeyRing(['a', 'b'], { now: () => 0 });
    ring.markCooldown('a', 30_000);
    ring.markCooldown('b', 30_000);
    expect(ring.rotate()).toBe(false);
    expect(ring.current()).toBe('a');
  });

  it('never leaves the provider without a key when the whole pool is cooling', () => {
    let now = 0;
    const ring = createKeyRing(['a', 'b'], { now: () => now });
    ring.markCooldown('a', 30_000);
    ring.markCooldown('b', 30_000);
    expect(ring.current()).toBe('a');
    now += 30_001;
    expect(ring.current()).toBe('a');
  });

  it('ignores cooldowns for unknown keys and non-positive durations', () => {
    const ring = createKeyRing(['a']);
    ring.markCooldown('nope', 30_000);
    ring.markCooldown('a', 0);
    expect(ring.rotate()).toBe(true);
  });

  describe('single-key pool', () => {
    it('current() returns the only key', () => {
      const ring = createKeyRing(['solo']);
      expect(ring.size()).toBe(1);
      expect(ring.current()).toBe('solo');
    });

    it('rotate() reports no movement unless the key is cooled', () => {
      const ring = createKeyRing(['solo'], { now: () => 0 });
      // Nothing to move to: the cursor stays on the only key.
      expect(ring.rotate()).toBe(true);
      expect(ring.current()).toBe('solo');

      ring.markCooldown('solo', API_KEY_COOLDOWN_MS);
      expect(ring.rotate()).toBe(false);
    });
  });
});
