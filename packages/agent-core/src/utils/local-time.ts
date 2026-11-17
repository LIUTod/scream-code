/**
 * Wall-clock time as the user lives it: local time with its UTC offset, plus
 * the IANA zone name when the runtime knows it.
 *
 * Cron fields are local time, so every timestamp the model reads next to a
 * schedule must be local too. A bare UTC `…Z` string forces the model to
 * convert by an offset it was never told, which is how "remind me in an hour"
 * ends up five hours late west of Greenwich or a year late east of it.
 */

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `+08:00` / `-05:00` / `+00:00` for the zone in force at `date`. */
function offsetOf(date: Date): string {
  // getTimezoneOffset is minutes *behind* UTC (UTC+8 reports -480).
  const minutesAhead = -date.getTimezoneOffset();
  const sign = minutesAhead >= 0 ? '+' : '-';
  const abs = Math.abs(minutesAhead);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * ISO 8601 in local time with the offset, e.g. `2026-11-18T05:00:00+08:00`.
 * Still a single unambiguous instant (`Date.parse` reads it back exactly), so
 * it can replace a UTC ISO string anywhere a machine also parses the value.
 */
export function formatLocalIso(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return 'invalid-date';
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    offsetOf(date)
  );
}

/** The IANA zone name (`Asia/Shanghai`), or undefined when the runtime has none. */
export function localTimeZoneName(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : undefined;
  } catch {
    return undefined;
  }
}

/** `Asia/Shanghai (UTC+08:00)`, or just `UTC+08:00` without a zone name. */
export function describeLocalTimeZone(ms: number): string {
  const offset = `UTC${offsetOf(new Date(ms))}`;
  const zone = localTimeZoneName();
  return zone === undefined ? offset : `${zone} (${offset})`;
}
