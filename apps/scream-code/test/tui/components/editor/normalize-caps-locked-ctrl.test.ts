import { describe, it, expect } from 'vitest';

import { normalizeCapsLockedCtrl } from '#/tui/components/editor/custom-editor';

// Kitty keyboard protocol emits `ESC[<codepoint>;<modifier+1>[:eventType]u`.
// Modifier mask bits: shift=1, alt=2, ctrl=4, super=8, hyper=16, meta=32,
// caps_lock=64, num_lock=128. The pi-tui bug this helper works around is
// that when caps_lock is on, terminals report the codepoint of ctrl+letter
// as the *uppercase* ASCII letter (e.g. 68 = 'D' instead of 100 = 'd'),
// which pi-tui's matcher compares literally and fails. We rewrite the
// sequence back to the unlocked form before dispatching.

describe('normalizeCapsLockedCtrl', () => {
  it('rewrites ctrl+D reported with caps_lock back to ctrl+d', () => {
    // ctrl(4) + caps_lock(64) = 68, reported = 69
    expect(normalizeCapsLockedCtrl('\u001B[68;69u')).toBe('\u001B[100;5u');
  });

  it('rewrites ctrl+C / ctrl+O / ctrl+S under caps_lock', () => {
    expect(normalizeCapsLockedCtrl('\u001B[67;69u')).toBe('\u001B[99;5u');
    expect(normalizeCapsLockedCtrl('\u001B[79;69u')).toBe('\u001B[111;5u');
    expect(normalizeCapsLockedCtrl('\u001B[83;69u')).toBe('\u001B[115;5u');
  });

  it('preserves the trailing event-type sub-parameter', () => {
    // `:3u` = key release event
    expect(normalizeCapsLockedCtrl('\u001B[68;69:3u')).toBe('\u001B[100;5:3u');
    // multiple sub-parameters still survive
    expect(normalizeCapsLockedCtrl('\u001B[68;69:3:1u')).toBe('\u001B[100;5:3:1u');
  });

  it('leaves plain uppercase typed with only caps_lock alone', () => {
    // User intentionally typing an uppercase letter — do not downgrade.
    // caps_lock(64) alone = 64, reported = 65
    expect(normalizeCapsLockedCtrl('\u001B[68;65u')).toBe('\u001B[68;65u');
  });

  it('leaves ctrl+letter without caps_lock alone', () => {
    // ctrl(4) alone = 4, reported = 5
    expect(normalizeCapsLockedCtrl('\u001B[68;5u')).toBe('\u001B[68;5u');
    expect(normalizeCapsLockedCtrl('\u001B[100;5u')).toBe('\u001B[100;5u');
  });

  it('leaves ctrl+shift+letter with caps_lock alone', () => {
    // shift(1) + ctrl(4) + caps_lock(64) = 69, reported = 70.
    // User explicitly wants the shifted form — don't rewrite.
    expect(normalizeCapsLockedCtrl('\u001B[68;70u')).toBe('\u001B[68;70u');
  });

  it('rewrites ctrl+alt+letter under caps_lock (shift not involved)', () => {
    // alt(2) + ctrl(4) + caps_lock(64) = 70, reported = 71
    expect(normalizeCapsLockedCtrl('\u001B[68;71u')).toBe('\u001B[100;7u');
  });

  it('ignores codepoints outside A-Z even with ctrl+caps_lock', () => {
    // Digit '1' (49) — uppercase mapping would be nonsense.
    expect(normalizeCapsLockedCtrl('\u001B[49;69u')).toBe('\u001B[49;69u');
    // Symbol '[' (91) — just past 'Z'.
    expect(normalizeCapsLockedCtrl('\u001B[91;69u')).toBe('\u001B[91;69u');
    // '@' (64) — just before 'A'.
    expect(normalizeCapsLockedCtrl('\u001B[64;69u')).toBe('\u001B[64;69u');
  });

  it('passes through non-CSI-u input unchanged', () => {
    // Plain printable character
    expect(normalizeCapsLockedCtrl('H')).toBe('H');
    // Legacy ctrl+d control byte
    expect(normalizeCapsLockedCtrl('\u0004')).toBe('\u0004');
    // Legacy ctrl+c control byte
    expect(normalizeCapsLockedCtrl('\u0003')).toBe('\u0003');
    // Arrow key CSI (not CSI-u)
    expect(normalizeCapsLockedCtrl('\u001B[A')).toBe('\u001B[A');
    // Empty string
    expect(normalizeCapsLockedCtrl('')).toBe('');
  });
});
