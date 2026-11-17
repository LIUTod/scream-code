import { describe, expect, it } from 'vitest';

import { formatDurationMs, parseDurationMs } from '#/cli/duration';

describe('parseDurationMs', () => {
  it.each([
    ['600', 600_000],
    ['1', 1000],
    ['90s', 90_000],
    ['10m', 600_000],
    ['1h', 3_600_000],
    ['2d', 172_800_000],
    ['1h30m', 5_400_000],
    ['2m30s', 150_000],
    ['1d2h3m4s', 93_784_000],
    ['1.5h', 5_400_000],
    ['0.5m', 30_000],
    ['  10M  ', 600_000],
  ])('reads %s as %d ms', (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it.each([
    '', '   ', 'abc', '10x', 'm10', '10 m', '1h 30m', '-5', '-5m', '1,5h', '1e3', '0', '0s', '0.5', '999ms',
    '10m5', '5mm', 'h',
  ])('rejects %j', (input) => {
    expect(parseDurationMs(input)).toBeUndefined();
  });

  it('accepts exactly one second and refuses anything shorter', () => {
    expect(parseDurationMs('1s')).toBe(1000);
    expect(parseDurationMs('0.999s')).toBeUndefined();
  });

  it('refuses a value a timer cannot hold (setTimeout would fire immediately past 2^31-1 ms)', () => {
    expect(parseDurationMs('24d')).toBe(2_073_600_000);
    expect(parseDurationMs('25d')).toBeUndefined();
    expect(parseDurationMs('99999999999')).toBeUndefined();
  });
});

describe('formatDurationMs', () => {
  it.each([
    [1000, '1s'],
    [1500, '1.5s'],
    [59_000, '59s'],
    [60_000, '1m'],
    [90_000, '1m30s'],
    [600_000, '10m'],
    [3_600_000, '1h'],
    [5_400_000, '1h30m'],
    [93_784_000, '1d2h3m4s'],
  ])('writes %d ms as %s', (ms, expected) => {
    expect(formatDurationMs(ms)).toBe(expected);
  });

  it('round-trips with the parser', () => {
    for (const text of ['45s', '12m', '3h', '1h30m', '2d4h']) {
      expect(formatDurationMs(parseDurationMs(text)!)).toBe(text);
    }
  });
});
