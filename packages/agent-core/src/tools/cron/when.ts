/**
 * One-shot times the model states in the user's own words — "in 1 hour",
 * "at 14:30", "on 2026-11-20 at 09:00" — turned into a pinned cron by code.
 *
 * Why this exists: a one-shot reminder written as a raw cron needs today's
 * local date and hour, and the model's only clock is the time stamped into its
 * system prompt when the session was opened. Doing that arithmetic itself, it
 * drifts with every hour the session has been open and is off by the UTC
 * offset whenever it reads the stamp as UTC. Here the date math happens
 * against the real local clock at the moment the task is created.
 *
 * The result is a normal 5-field cron (`M H DoM Mon *`), so the rest of the
 * stack (store, scheduler, jitter, persistence, list/delete) is unchanged.
 * Every result is checked by asking the cron engine for its first fire: when
 * that is not exactly the intended instant (the repeated hour when daylight
 * saving ends, say), the request is refused rather than scheduled wrong.
 */

import { formatLocalIso } from '../../utils/local-time';
import { computeNextCronRun, parseCronExpression } from './cron-expr';

const MS_PER_MINUTE = 60_000;
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: MS_PER_MINUTE,
  h: 60 * MS_PER_MINUTE,
  d: 24 * 60 * MS_PER_MINUTE,
};

/**
 * Furthest a one-shot may land. A pinned `M H DoM Mon *` cron repeats every
 * year, so its first match is only the intended day while that day is less
 * than a year away; this matches the one-shot rollover guard in `./schedule`.
 */
export const ONE_SHOT_MAX_FUTURE_MS = 350 * 24 * 60 * MS_PER_MINUTE;

export type OneShotWhen =
  | { readonly ok: true; readonly cron: string; readonly fireAt: number }
  | { readonly ok: false; readonly error: string };

/** `90s`, `10m`, `1h30m`, `1.5h`, `2d` → ms; undefined for anything else (a bare number is ambiguous). */
export function parseDelayMs(input: string): number | undefined {
  const text = input.trim().toLowerCase().replaceAll(/\s+/g, '');
  if (!/^(?:\d+(?:\.\d+)?[smhd])+$/.test(text)) return undefined;
  let total = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) {
    total += Number(match[1]) * UNIT_MS[match[2]!]!;
  }
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

/**
 * Local time, 24-hour clock:
 *   - `14:30` — the next 14:30 from now (today if still ahead, else tomorrow);
 *   - `today 14:30` / `tomorrow 09:00` — that day, never rolled forward;
 *   - `2026-11-20 09:00` (or `2026-11-20T09:00`) — that date.
 */
function parseAt(input: string, nowMs: number): { at: number } | { error: string } {
  const text = input.trim().replaceAll(/\s+/g, ' ');
  const timeOnly = /^(?:(today|tomorrow) )?(\d{1,2}):(\d{2})$/i.exec(text);
  const dated = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/.exec(text);
  if (timeOnly === null && dated === null) {
    return {
      error: `"at" must be HH:MM, today HH:MM, tomorrow HH:MM or YYYY-MM-DD HH:MM in local 24-hour time; got ${JSON.stringify(input)}.`,
    };
  }
  const hour = Number(timeOnly === null ? dated![4] : timeOnly[2]);
  const minute = Number(timeOnly === null ? dated![5] : timeOnly[3]);
  const day = timeOnly?.[1]?.toLowerCase();
  if (hour > 23 || minute > 59) {
    return { error: `"at" ${JSON.stringify(input)} is not a valid time of day.` };
  }

  const build = (year: number, monthIndex: number, day: number): Date | undefined => {
    const candidate = new Date(year, monthIndex, day, hour, minute, 0, 0);
    // A calendar date that does not exist (Feb 30) or a local time skipped by a
    // daylight-saving jump comes back normalised to a different value.
    return candidate.getFullYear() === year &&
      candidate.getMonth() === monthIndex &&
      candidate.getDate() === day &&
      candidate.getHours() === hour &&
      candidate.getMinutes() === minute
      ? candidate
      : undefined;
  };

  if (dated !== null) {
    const target = build(Number(dated[1]), Number(dated[2]) - 1, Number(dated[3]));
    if (target === undefined) {
      return { error: `"at" ${JSON.stringify(input)} is not a real local date and time (no such day, or skipped by a daylight-saving change).` };
    }
    return { at: target.getTime() };
  }

  const now = new Date(nowMs);
  const today = build(now.getFullYear(), now.getMonth(), now.getDate());
  if (day === 'today') {
    if (today === undefined) {
      return { error: `"at" ${JSON.stringify(input)} does not exist today in local time (skipped by a daylight-saving change).` };
    }
    // Returned even when already past: the caller reports "in the past" with
    // the current time instead of silently moving the reminder to tomorrow.
    return { at: today.getTime() };
  }
  if (day === undefined && today !== undefined && today.getTime() > nowMs) return { at: today.getTime() };
  // Tomorrow, built from the calendar date rather than "+24h" so a
  // daylight-saving change in between does not shift the hour.
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const tomorrow = build(next.getFullYear(), next.getMonth(), next.getDate());
  if (tomorrow === undefined) {
    return { error: `"at" ${JSON.stringify(input)} does not exist tomorrow in local time (skipped by a daylight-saving change).` };
  }
  return { at: tomorrow.getTime() };
}

/**
 * Resolve `in` / `at` to a pinned one-shot cron at `nowMs`. Exactly one of the
 * two must be given. `in` is rounded up to the next whole minute (cron has
 * minute resolution, and rounding down would fire early).
 */
export function resolveOneShotWhen(
  when: { readonly in?: string | undefined; readonly at?: string | undefined },
  nowMs: number,
): OneShotWhen {
  const nowText = formatLocalIso(nowMs);
  let fireAt: number;
  if (when.in !== undefined) {
    const delay = parseDelayMs(when.in);
    if (delay === undefined) {
      return { ok: false, error: `"in" must be a delay such as 90s, 10m, 1h30m or 2d; got ${JSON.stringify(when.in)}.` };
    }
    fireAt = Math.ceil((nowMs + delay) / MS_PER_MINUTE) * MS_PER_MINUTE;
  } else if (when.at !== undefined) {
    const parsed = parseAt(when.at, nowMs);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    fireAt = parsed.at;
    if (fireAt <= nowMs) {
      return { ok: false, error: `"at" ${JSON.stringify(when.at)} is already in the past (now ${nowText}).` };
    }
  } else {
    return { ok: false, error: 'Give one of "cron", "in" or "at".' };
  }

  if (fireAt - nowMs > ONE_SHOT_MAX_FUTURE_MS) {
    return {
      ok: false,
      error: `A one-shot must fire within 350 days; ${formatLocalIso(fireAt)} is further out (now ${nowText}).`,
    };
  }

  const at = new Date(fireAt);
  const cron = `${String(at.getMinutes())} ${String(at.getHours())} ${String(at.getDate())} ${String(at.getMonth() + 1)} *`;
  // The engine is the source of truth for when this cron fires. If its first
  // match is not the instant we meant — the repeated hour when daylight saving
  // ends matches the earlier pass — refuse instead of firing at the wrong time.
  if (computeNextCronRun(parseCronExpression(cron), nowMs) !== fireAt) {
    return {
      ok: false,
      error: `${formatLocalIso(fireAt)} cannot be pinned as a one-shot cron (a daylight-saving change makes that local time ambiguous); pick a time outside that hour.`,
    };
  }
  return { ok: true, cron, fireAt };
}
