/**
 * `in` / `at` one-shots are resolved by code against the real local clock, so
 * these tests pin the process time zone and check the instant the cron engine
 * will actually fire — including the daylight-saving hours where a naive
 * "build a cron from local fields" would fire at the wrong time.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { computeNextCronRun, parseCronExpression } from '../../../src/tools/cron/cron-expr';
import { ONE_SHOT_MAX_FUTURE_MS, parseDelayMs, resolveOneShotWhen } from '../../../src/tools/cron/when';
import { describeLocalTimeZone, formatLocalIso } from '../../../src/utils/local-time';

const ORIGINAL_TZ = process.env['TZ'];

function useTimeZone(zone: string): void {
  process.env['TZ'] = zone;
}

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env['TZ'];
  else process.env['TZ'] = ORIGINAL_TZ;
});

/** The resolved cron, and the instant the engine fires it from `nowMs`. */
function resolve(when: { in?: string; at?: string }, nowMs: number): { cron: string; fireAt: number; engine: number | null } {
  const result = resolveOneShotWhen(when, nowMs);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return {
    cron: result.cron,
    fireAt: result.fireAt,
    engine: computeNextCronRun(parseCronExpression(result.cron), nowMs),
  };
}

function refusal(when: { in?: string; at?: string }, nowMs: number): string {
  const result = resolveOneShotWhen(when, nowMs);
  if (result.ok) throw new Error(`expected a refusal, got cron ${result.cron}`);
  return result.error;
}

describe('parseDelayMs', () => {
  it.each([
    ['90s', 90_000],
    ['20m', 1_200_000],
    ['2h', 7_200_000],
    ['1h30m', 5_400_000],
    ['1.5h', 5_400_000],
    ['2d', 172_800_000],
    [' 1H 30M ', 5_400_000],
  ])('%s → %d ms', (text, ms) => {
    expect(parseDelayMs(text)).toBe(ms);
  });

  it.each(['', '20', 'soon', '-5m', '0m', 'm', '5 minutes', '1w'])('rejects %j', (text) => {
    expect(parseDelayMs(text)).toBeUndefined();
  });
});

describe('"in" — counted from now, rounded up to the minute', () => {
  it('fires exactly the delay later, on the next whole minute, in any zone', () => {
    for (const zone of ['America/New_York', 'Asia/Shanghai', 'Europe/London', 'Asia/Kolkata']) {
      useTimeZone(zone);
      const now = Date.UTC(2026, 10, 17, 20, 0, 0); // 20:00:00Z
      const { fireAt, engine } = resolve({ in: '1h' }, now);
      expect(fireAt, zone).toBe(now + 3_600_000);
      // The engine fires the pinned cron at exactly that instant — not shifted
      // by the zone's offset, which is the bug this feature exists to remove.
      expect(engine, zone).toBe(fireAt);
    }
  });

  it('rounds a mid-minute target up, never down (so it never fires early)', () => {
    useTimeZone('Asia/Shanghai');
    const now = Date.UTC(2026, 10, 17, 6, 23, 40); // 14:23:40 local
    const { cron, fireAt, engine } = resolve({ in: '30s' }, now);
    expect(fireAt).toBe(Date.UTC(2026, 10, 17, 6, 25, 0)); // 14:24:10 → 14:25
    expect(cron).toBe('25 14 17 11 *');
    expect(engine).toBe(fireAt);
  });

  it('crosses midnight and month ends using the local calendar', () => {
    useTimeZone('Asia/Shanghai');
    const now = Date.UTC(2026, 10, 30, 15, 30, 0); // Nov 30 23:30 local
    const { cron, engine, fireAt } = resolve({ in: '1h' }, now);
    expect(cron).toBe('30 0 1 12 *'); // Dec 1 00:30 local
    expect(engine).toBe(fireAt);
  });

  it('refuses a bad delay and a delay past the one-shot window', () => {
    useTimeZone('UTC');
    const now = Date.UTC(2026, 0, 1);
    expect(refusal({ in: 'soon' }, now)).toMatch(/"in" must be a delay/);
    expect(refusal({ in: '351d' }, now)).toMatch(/within 350 days/);
    expect(resolveOneShotWhen({ in: '349d' }, now).ok).toBe(true);
    expect(ONE_SHOT_MAX_FUTURE_MS).toBe(350 * 86_400_000);
  });
});

describe('"at" — a local wall-clock time', () => {
  it('HH:MM is today while still ahead, tomorrow once it has passed', () => {
    useTimeZone('Asia/Shanghai');
    const morning = Date.UTC(2026, 10, 17, 1, 0); // 09:00 local
    const today = resolve({ at: '15:00' }, morning);
    expect(today.cron).toBe('0 15 17 11 *');
    expect(today.engine).toBe(today.fireAt);

    const evening = Date.UTC(2026, 10, 17, 8, 0); // 16:00 local
    const tomorrow = resolve({ at: '15:00' }, evening);
    expect(tomorrow.cron).toBe('0 15 18 11 *');
    expect(tomorrow.engine).toBe(tomorrow.fireAt);
  });

  it('the current minute counts as passed (a one-shot must be in the future)', () => {
    useTimeZone('UTC');
    const now = Date.UTC(2026, 10, 17, 15, 0, 0);
    expect(resolve({ at: '15:00' }, now).cron).toBe('0 15 18 11 *');
  });

  it('uses the local date, not the UTC one — the Shanghai early-morning case', () => {
    // 04:00 on Nov 18 in Shanghai is still Nov 17 in UTC; a model reading a
    // UTC stamp would pin the 17th and the reminder would roll a year ahead.
    useTimeZone('Asia/Shanghai');
    const now = Date.UTC(2026, 10, 17, 20, 0); // Nov 18 04:00 local
    const { cron, engine, fireAt } = resolve({ at: '09:00' }, now);
    expect(cron).toBe('0 9 18 11 *');
    expect(fireAt - now).toBe(5 * 3_600_000);
    expect(engine).toBe(fireAt);
  });

  it('"tomorrow HH:MM" never means today, even before that hour', () => {
    useTimeZone('Europe/London');
    const now = Date.UTC(2026, 10, 17, 7, 0); // 07:00 local
    expect(resolve({ at: 'tomorrow 09:00' }, now).cron).toBe('0 9 18 11 *');
    expect(resolve({ at: 'Tomorrow  9:05' }, now).cron).toBe('5 9 18 11 *');
  });

  it('"today HH:MM" that already passed is refused, not moved to tomorrow', () => {
    useTimeZone('Europe/London');
    const now = Date.UTC(2026, 10, 17, 12, 0); // 12:00 local
    expect(refusal({ at: 'today 09:00' }, now)).toMatch(/already in the past \(now 2026-11-17T12:00:00\+00:00\)/);
    expect(resolve({ at: 'today 18:30' }, now).cron).toBe('30 18 17 11 *');
  });

  it('a dated time is taken as that local date and time', () => {
    useTimeZone('America/New_York');
    const now = Date.UTC(2026, 10, 17, 20, 0);
    const { cron, fireAt, engine } = resolve({ at: '2026-11-20 09:00' }, now);
    expect(cron).toBe('0 9 20 11 *');
    expect(fireAt).toBe(Date.UTC(2026, 10, 20, 14, 0)); // 09:00 EST = 14:00Z
    expect(engine).toBe(fireAt);
    expect(resolve({ at: '2026-11-20T09:00' }, now).fireAt).toBe(fireAt);
  });

  it.each([
    ['25:00', /not a valid time/],
    ['12:60', /not a valid time/],
    ['3pm', /must be HH:MM/],
    ['2026-02-30 09:00', /not a real local date/],
    ['2025-01-01 09:00', /already in the past/],
    ['2028-01-01 09:00', /within 350 days/],
  ])('refuses %j', (at, pattern) => {
    useTimeZone('UTC');
    expect(refusal({ at }, Date.UTC(2026, 10, 17, 12, 0))).toMatch(pattern);
  });
});

describe('daylight-saving edges (America/New_York, 2026)', () => {
  it('refuses a local time skipped when clocks spring forward (Mar 8, 02:30)', () => {
    useTimeZone('America/New_York');
    const now = Date.UTC(2026, 2, 7, 12, 0);
    expect(refusal({ at: '2026-03-08 02:30' }, now)).toMatch(/skipped by a daylight-saving change/);
  });

  it('refuses an "in" that lands in the second pass of the repeated hour (Nov 1, 01:xx)', () => {
    // 00:50 EDT + 1h20m = 01:10 EST, but `10 1 1 11 *` first matches 01:10 EDT
    // — an hour early. The tool refuses rather than firing at the wrong time.
    useTimeZone('America/New_York');
    const now = Date.UTC(2026, 10, 1, 4, 50); // 00:50 EDT
    expect(refusal({ in: '1h20m' }, now)).toMatch(/daylight-saving change makes that local time ambiguous/);
  });

  it('an "in" that lands outside the changed hour is fine across the switch', () => {
    useTimeZone('America/New_York');
    const now = Date.UTC(2026, 10, 1, 4, 50); // 00:50 EDT
    const { fireAt, engine } = resolve({ in: '3h' }, now); // 02:50 EST
    expect(fireAt).toBe(now + 3 * 3_600_000);
    expect(engine).toBe(fireAt);
  });

  it('"tomorrow" keeps the wall-clock hour across the switch (not +24h)', () => {
    useTimeZone('America/New_York');
    const now = Date.UTC(2026, 9, 31, 13, 0); // Oct 31 09:00 EDT
    const { cron, fireAt, engine } = resolve({ at: 'tomorrow 09:00' }, now);
    expect(cron).toBe('0 9 1 11 *');
    expect(fireAt - now).toBe(25 * 3_600_000); // the day is 25 hours long
    expect(engine).toBe(fireAt);
  });
});

describe('local time formatting', () => {
  it('writes local ISO with the offset, which parses back to the same instant', () => {
    for (const [zone, expected] of [
      ['Asia/Shanghai', '2026-11-18T04:00:00+08:00'],
      ['America/New_York', '2026-11-17T15:00:00-05:00'],
      ['Asia/Kolkata', '2026-11-18T01:30:00+05:30'],
      ['UTC', '2026-11-17T20:00:00+00:00'],
    ] as const) {
      useTimeZone(zone);
      const ms = Date.UTC(2026, 10, 17, 20, 0);
      expect(formatLocalIso(ms), zone).toBe(expected);
      expect(Date.parse(formatLocalIso(ms)), zone).toBe(ms);
    }
  });

  it('names the zone with its offset', () => {
    useTimeZone('Asia/Shanghai');
    expect(describeLocalTimeZone(Date.UTC(2026, 10, 17))).toBe('Asia/Shanghai (UTC+08:00)');
  });
});
