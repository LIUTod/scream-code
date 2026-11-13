import { describe, expect, it } from 'vitest';

import { RepetitionGuard } from '../../src/tools/support/repetition-guard';

describe('RepetitionGuard', () => {
  it('climbs the level ladder: silent, note, stop re-reading', () => {
    const guard = new RepetitionGuard();
    expect(guard.record('k', 'f1')).toEqual({ count: 1, level: 0 });
    expect(guard.record('k', 'f1')).toEqual({ count: 2, level: 1 });
    expect(guard.record('k', 'f1')).toEqual({ count: 3, level: 1 });
    expect(guard.record('k', 'f1')).toEqual({ count: 4, level: 2 });
    expect(guard.record('k', 'f1')).toEqual({ count: 5, level: 2 });
  });

  it('tracks keys independently', () => {
    const guard = new RepetitionGuard();
    expect(guard.record('a', 'f1')).toEqual({ count: 1, level: 0 });
    expect(guard.record('b', 'f1')).toEqual({ count: 1, level: 0 });
    expect(guard.record('a', 'f1')).toEqual({ count: 2, level: 1 });
    expect(guard.record('b', 'f1')).toEqual({ count: 2, level: 1 });
  });

  it('resets to count 1 when the fingerprint changes (file edited, different window)', () => {
    const guard = new RepetitionGuard();
    guard.record('k', 'f1');
    expect(guard.record('k', 'f1')).toEqual({ count: 2, level: 1 });
    expect(guard.record('k', 'f2')).toEqual({ count: 1, level: 0 });
    expect(guard.record('k', 'f2')).toEqual({ count: 2, level: 1 });
  });

  it('forget drops the count entirely', () => {
    const guard = new RepetitionGuard();
    guard.record('k', 'f1');
    guard.record('k', 'f1');
    guard.forget('k');
    expect(guard.record('k', 'f1')).toEqual({ count: 1, level: 0 });
    // Forgetting an unknown key is a no-op.
    expect(() => {
      guard.forget('never-recorded');
    }).not.toThrow();
  });

  it('evicts the least-recently-used key past the 256-key cap', () => {
    const guard = new RepetitionGuard();
    for (let i = 0; i < 256; i += 1) {
      guard.record(`k${String(i)}`, 'f1');
    }
    // Touch the oldest key so it becomes most-recent; k1 is now the LRU.
    expect(guard.record('k0', 'f1')).toEqual({ count: 2, level: 1 });
    guard.record('k256', 'f1');
    // k1 was evicted, so it starts over; k0 survived because it was touched.
    expect(guard.record('k1', 'f1')).toEqual({ count: 1, level: 0 });
    expect(guard.record('k0', 'f1')).toEqual({ count: 3, level: 1 });
  });

  it('keys reads on the raw path string', () => {
    expect(RepetitionGuard.readKey('/a.ts')).toBe('read:/a.ts');
    expect(RepetitionGuard.readKey('/a.ts')).toBe(RepetitionGuard.readKey('/a.ts'));
    expect(RepetitionGuard.readKey('/a.ts')).not.toBe(RepetitionGuard.readKey('/b.ts'));
  });

  it('hashes grep keys from the canonical argument object, ignoring key order', () => {
    const a = RepetitionGuard.grepKey(JSON.stringify({ pattern: 'x', path: '/a' }));
    const b = RepetitionGuard.grepKey(JSON.stringify({ path: '/a', pattern: 'x' }));
    expect(a).toBe(b);
    expect(RepetitionGuard.grepKey(JSON.stringify({ pattern: 'x', path: '/a' }))).not.toBe(
      RepetitionGuard.grepKey(JSON.stringify({ pattern: 'x', path: '/b' })),
    );
    // Nested objects are canonicalized too.
    const nested = RepetitionGuard.grepKey(
      JSON.stringify({ opts: { b: 1, a: 2 }, pattern: 'x' }),
    );
    const nestedReordered = RepetitionGuard.grepKey(
      JSON.stringify({ pattern: 'x', opts: { a: 2, b: 1 } }),
    );
    expect(nested).toBe(nestedReordered);
  });

  it('produces a deterministic key even for malformed argument JSON', () => {
    expect(RepetitionGuard.grepKey('not json')).toBe(RepetitionGuard.grepKey('not json'));
    expect(RepetitionGuard.grepKey('not json')).not.toBe(RepetitionGuard.grepKey('other junk'));
  });
});
