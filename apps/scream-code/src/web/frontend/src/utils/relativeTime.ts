/**
 * Relative time labels for the session list (L2).
 *
 * Format: today → `HH:mm`; yesterday → LABEL_YESTERDAY; within 7 days → number + day suffix;
 * older → `M/D`. Day boundaries follow the local calendar day (a session from 23:00 yesterday
 * must not read as "1 day ago"), matching the calendar-day semantics of isSameLocalDay in
 * utils/timeFormat.ts.
 *
 * The web app has no i18n runtime (product copy is hard-coded Chinese), so the labels here are
 * emitted as Chinese strings as well; when localization lands, replace LABEL_YESTERDAY / the
 * suffix with t().
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Above this calendar-day difference the label stops using "N days ago" and falls back to a concrete date. */
const RELATIVE_DAY_LIMIT = 7;
const LABEL_YESTERDAY = '昨天';

/**
 * Local calendar-day index: timestamps on the same day in the same time zone get the same integer.
 *
 * Fields are read locally (Y/M/D) and recombined via UTC instead of "local midnight / 86400000,
 * rounded": the latter puts local midnight at a fractional position on the UTC timeline, and a
 * DST offset change flips the rounding direction of Math.round, inventing a day of difference
 * (observed in practice with TZ=Pacific/Auckland: 9/25 09:00(+12) → 9/28 09:00(+13) is a true
 * gap of 3, the rounding approach computes 2; the reverse 4/3→4/6 computes 4). Every Date.UTC
 * day is exactly 24 hours, so field-wise recombination has no such edge case.
 */
function localDayIndex(ts: number): number {
  const date = new Date(ts);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

function clockTime(ts: number): string {
  const date = new Date(ts);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * @param ts event timestamp (ms epoch)
 * @param now reference "now", defaults to Date.now(); tests pass a fixed value for deterministic output
 * @returns relative time label; an empty string when ts is missing/invalid (callers decide the placeholder)
 */
export function relativeTimeLabel(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  // Future timestamps (clock skew) are treated as today, avoiding a "-1 days ago" label.
  const dayGap = localDayIndex(now) - localDayIndex(ts);
  if (dayGap <= 0) return clockTime(ts);
  if (dayGap === 1) return LABEL_YESTERDAY;
  if (dayGap <= RELATIVE_DAY_LIMIT) return `${dayGap} 天前`;
  const date = new Date(ts);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
