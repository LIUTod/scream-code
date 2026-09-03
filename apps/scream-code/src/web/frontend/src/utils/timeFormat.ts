/**
 * Message timestamp for the meta row — mirrors the reference formatting:
 * today → `HH:MM`; past days → `M月D日 HH:MM`; past years → `YYYY年M月D日 HH:MM`.
 * A time-only label for a message from yesterday would read as today, so
 * cross-day entries carry their date.
 */
export function formatMessageTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const sameDay =
    d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return time;
  const sameYear = d.getFullYear() === n.getFullYear();
  const date = sameYear
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  return `${date} ${time}`;
}

/** True when both timestamps fall on the same local calendar day. */
export function isSameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear()
    && x.getMonth() === y.getMonth()
    && x.getDate() === y.getDate()
  );
}

/**
 * Day-divider label for the message stream: `9月2日` inside the current
 * year, `2025年12月31日` once the year differs from `now`.
 */
export function formatDayDivider(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}