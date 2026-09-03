import { describe, expect, it } from 'vitest';

import {
  formatDayDivider,
  formatMessageTime,
  isSameLocalDay,
} from '../../src/web/frontend/src/utils/timeFormat';

// Fixed "now" for deterministic cross-day/cross-year assertions.
// 2026-09-02T12:34:56 local time.
const NOW = new Date(2026, 8, 2, 12, 34, 56).getTime();

describe('formatMessageTime', () => {
  it('renders same-day timestamps as time only', () => {
    const ts = new Date(2026, 8, 2, 9, 5).getTime();
    const out = formatMessageTime(ts, NOW);
    // Locale-dependent zero padding; just require the time-only shape.
    expect(out).toMatch(/^\d{1,2}:\d{2}$/);
    expect(out).not.toContain('月');
  });

  it('appends the date for messages from previous days', () => {
    const ts = new Date(2026, 8, 1, 22, 30).getTime(); // yesterday
    const out = formatMessageTime(ts, NOW);
    expect(out).toMatch(/月\d{1,2}日 \d{1,2}:\d{2}$/);
    expect(out).toContain('9月1日');
  });

  it('includes the year for messages from previous years', () => {
    const ts = new Date(2025, 11, 31, 23, 59).getTime();
    const out = formatMessageTime(ts, NOW);
    expect(out).toContain('2025年12月31日');
    expect(out).toMatch(/\d{2}:\d{2}$/);
  });

  it('uses Date.now() when no reference is given', () => {
    const ts = new Date(2026, 8, 1, 10, 0).getTime();
    // Cannot control the real clock; both branches just must not throw and
    // must return a non-empty string.
    expect(formatMessageTime(ts)).toBeTruthy();
  });
});

describe('formatDayDivider', () => {
  it('renders month-day only inside the current year', () => {
    const ts = new Date(2026, 8, 2, 3, 0).getTime();
    expect(formatDayDivider(ts, NOW)).toBe('9月2日');
  });

  it('includes the year for past years', () => {
    const ts = new Date(2025, 11, 31, 23, 0).getTime();
    expect(formatDayDivider(ts, NOW)).toBe('2025年12月31日');
  });

  it('uses Date.now() when no reference is given', () => {
    expect(formatDayDivider(Date.now())).toMatch(/^(20\d\d年)?\d{1,2}月\d{1,2}日$/);
  });
});

describe('isSameLocalDay', () => {
  it('is true within one day and false across midnight', () => {
    const morning = new Date(2026, 8, 2, 0, 0, 1).getTime();
    const night = new Date(2026, 8, 2, 23, 59, 59).getTime();
    const nextDay = new Date(2026, 8, 3, 0, 0, 0).getTime();
    expect(isSameLocalDay(morning, night)).toBe(true);
    expect(isSameLocalDay(night, nextDay)).toBe(false);
  });

  it('is false across month and year boundaries', () => {
    expect(isSameLocalDay(new Date(2026, 7, 31).getTime(), new Date(2026, 8, 1).getTime())).toBe(false);
    expect(isSameLocalDay(new Date(2025, 11, 31).getTime(), new Date(2026, 0, 1).getTime())).toBe(false);
  });
});