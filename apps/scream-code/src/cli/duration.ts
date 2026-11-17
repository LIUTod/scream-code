/**
 * Human durations for command-line flags: `600`, `90s`, `10m`, `1h30m`, `2d`.
 *
 * A bare number is seconds. The result is milliseconds, at least one second and
 * small enough for a timer (`setTimeout` overflows past 2^31-1 ms and would fire
 * at once instead of waiting), or `undefined` for anything that is not a
 * duration — callers turn that into their own message.
 */

const MAX_TIMER_MS = 2_147_483_647;
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDurationMs(input: string): number | undefined {
  const text = input.trim().toLowerCase();
  let total: number;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    total = Number(text) * 1000;
  } else if (/^(?:\d+(?:\.\d+)?[smhd])+$/.test(text)) {
    total = 0;
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) {
      total += Number(match[1]) * UNIT_MS[match[2]!]!;
    }
  } else {
    return undefined;
  }
  const ms = Math.round(total);
  return Number.isFinite(ms) && ms >= 1000 && ms <= MAX_TIMER_MS ? ms : undefined;
}

/** The inverse, for messages: `600000` → `10m`, `5400000` → `1h30m`, `1500` → `1.5s`. */
export function formatDurationMs(ms: number): string {
  if (ms < 60_000) return `${String(Math.round(ms / 100) / 10)}s`;
  const parts: string[] = [];
  let rest = Math.round(ms / 1000);
  const days = Math.floor(rest / 86_400);
  rest -= days * 86_400;
  const hours = Math.floor(rest / 3600);
  rest -= hours * 3600;
  const minutes = Math.floor(rest / 60);
  const seconds = rest - minutes * 60;
  if (days > 0) parts.push(`${String(days)}d`);
  if (hours > 0) parts.push(`${String(hours)}h`);
  if (minutes > 0) parts.push(`${String(minutes)}m`);
  if (seconds > 0) parts.push(`${String(seconds)}s`);
  return parts.join('');
}
