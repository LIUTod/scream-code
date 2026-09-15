import { describe, expect, it } from 'vitest';

import { relativeTimeLabel } from '../../src/web/frontend/src/utils/relativeTime';

/**
 * Relative time wording for the session list. Every time is built from a local
 * instant with a fixed reference point, so the suite is unaffected by the runtime
 * timezone (the helper itself works in local calendar days).
 */

/** Build offsets relative to "now"; the reference is a safe local midday, avoiding midnight rollover flakiness. */
const NOW = new Date(2026, 8, 14, 13, 5, 0).getTime(); // fixed local reference instant
const at = (y: number, mo: number, d: number, h = 9, mi = 5) =>
  new Date(y, mo, d, h, mi, 0).getTime();

describe('relativeTimeLabel', () => {
  it('earlier today -> HH:mm (zero-padded 24-hour clock)', () => {
    expect(relativeTimeLabel(at(2026, 8, 14, 0, 3), NOW)).toBe('00:03');
    expect(relativeTimeLabel(at(2026, 8, 14, 8, 40), NOW)).toBe('08:40');
    expect(relativeTimeLabel(at(2026, 8, 14, 13, 4), NOW)).toBe('13:04');
  });

  it('yesterday -> "yesterday" even when only minutes apart (calendar-day wording)', () => {
    // 3 minutes before 13:05 is 13:02 (same day) -> still HH:mm
    expect(relativeTimeLabel(at(2026, 8, 14, 13, 2), NOW)).toBe('13:02');
    // Yesterday at 23:00: one calendar day apart -> yesterday (not "hours ago")
    expect(relativeTimeLabel(at(2026, 8, 13, 23, 0), NOW)).toBe('昨天');
    expect(relativeTimeLabel(at(2026, 8, 13, 0, 30), NOW)).toBe('昨天');
  });

  it('within 7 days -> "N days ago", the 7th day inclusive', () => {
    expect(relativeTimeLabel(at(2026, 8, 12, 10, 0), NOW)).toBe('2 天前');
    expect(relativeTimeLabel(at(2026, 8, 7, 10, 0), NOW)).toBe('7 天前');
    // The 8th day falls back to the concrete date (September 6 -> 9/6)
    expect(relativeTimeLabel(at(2026, 8, 6, 10, 0), NOW)).toBe('9/6');
  });

  it('anything older -> M/D (no zero padding)', () => {
    expect(relativeTimeLabel(at(2026, 0, 5, 10, 0), NOW)).toBe('1/5');
    expect(relativeTimeLabel(at(2025, 11, 31, 10, 0), NOW)).toBe('12/31');
  });

  it('the calendar-day difference across a DST switch is computed from local Y/M/D (regression)', () => {
    // This scenario only exists in a timezone with DST, and the process timezone is
    // decided by the environment. Node allows rewriting process.env.TZ at runtime
    // (which invalidates its internal timezone cache), so it is restored immediately
    // afterwards to avoid polluting other cases in the same process; where the
    // platform cannot switch timezones, the offset assertions below fail loudly - a
    // case must never turn green because its setup could not be constructed.
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Auckland';
      // First confirm the timezone really switched: NZDT (+13, January) / NZST (+12, September).
      expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(-13 * 60);
      expect(new Date(2026, 8, 20).getTimezoneOffset()).toBe(-12 * 60);

      // New Zealand DST starts at 2026-09-27 02:00 (+12 -> +13). Take 9/25 before
      // the switch and 9/28 after it: the real calendar-day difference is 3 (the old
      // "local midnight / 86400000 rounding" wording computed 2).
      expect(relativeTimeLabel(at(2026, 8, 25, 9), at(2026, 8, 28, 9))).toBe('3 天前');
      // DST ends at 2026-04-05 03:00 (+13 -> +12), the opposite skew: really 3 days,
      // the old wording computed 4.
      expect(relativeTimeLabel(at(2026, 3, 3, 9), at(2026, 3, 6, 9))).toBe('3 天前');
      // The day difference also picks the "N days ago / M/D" branch: 9/22 -> 9/30 is
      // really 8 days and must fall back to the concrete date, while the old wording
      // counted 7 and misreported a "7 days ago" label one bucket off.
      expect(relativeTimeLabel(at(2026, 8, 22, 9), at(2026, 8, 30, 9))).toBe('9/22');
      // The "yesterday" boundary across DST uses the same wording: 9/26 23:00 -> 9/27 01:00 are adjacent days.
      expect(relativeTimeLabel(at(2026, 8, 26, 23), at(2026, 8, 27, 1))).toBe('昨天');
    } finally {
      // The original value may be undefined: assigning undefined directly would turn
      // it into the string "undefined", so the key has to be deleted.
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('a future timestamp (clock skew) is treated as today and never yields "-1 days ago"', () => {
    expect(relativeTimeLabel(at(2026, 8, 14, 14, 0), NOW)).toBe('14:00');
    expect(relativeTimeLabel(at(2026, 8, 15, 14, 0), NOW)).toBe('14:00');
  });

  it('missing or invalid timestamps return an empty string for the caller to fill in', () => {
    expect(relativeTimeLabel(0, NOW)).toBe('');
    expect(relativeTimeLabel(Number.NaN, NOW)).toBe('');
  });

  it('defaults the reference to Date.now()', () => {
    const now = Date.now();
    expect(relativeTimeLabel(now - 60_000)).toMatch(/^\d{2}:\d{2}$|^昨天$/);
  });
});
