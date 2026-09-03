/**
 * Client-side tool timing. The protocol carries no timestamps, so the web
 * client records a start time when tool.call.started arrives and consumes it
 * on tool.result (writing ToolMessage.durationMs); running cards read the
 * live start time for an elapsed chip. Module-level so cards can peek without
 * prop drilling; cleared at every turn start so it never leaks across turns.
 */

const startTimes = new Map<string, number>();

export function recordToolStart(toolCallId: string): void {
  startTimes.set(toolCallId, Date.now());
}

/** Start time of a still-running tool (non-destructive). */
export function peekToolStart(toolCallId: string): number | undefined {
  return startTimes.get(toolCallId);
}

/** Consume the start time when the tool finishes; undefined if unknown. */
export function takeToolStart(toolCallId: string): number | undefined {
  const t = startTimes.get(toolCallId);
  if (t !== undefined) startTimes.delete(toolCallId);
  return t;
}

export function clearToolStarts(): void {
  startTimes.clear();
}

/** Compact duration chip: 1.2s / 45s / 1m23s. */
export function formatToolDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}
