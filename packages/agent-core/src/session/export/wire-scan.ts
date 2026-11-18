import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'pathe';

export interface SessionWireScan {
  readonly firstActivityMs?: number | undefined;
  readonly lastActivityMs?: number | undefined;
}

/**
 * Where a session keeps its main agent's wire: `agents/main/wire.jsonl` (every
 * agent has its own directory under `agents/`), with the session-level
 * `wire.jsonl` the session store also accepts as a fallback.
 */
const MAIN_WIRE_CANDIDATES = [join('agents', 'main', 'wire.jsonl'), 'wire.jsonl'] as const;

/**
 * Scan a session's main-agent wire for its first and last activity timestamps
 * (every record carries `time`).
 *
 * The log is append-only and line-delimited, but a long-lived session can grow
 * it to gigabytes, so it is streamed rather than read into a single string: a
 * `StringDecoder` turns each chunk into text without splitting multi-byte
 * characters, complete lines are consumed as they arrive, and only the two
 * timestamps are retained. A wire that cannot be read (including a missing
 * file) falls through to the next location, then to an empty scan.
 */
export async function scanSessionWire(sessionDir: string): Promise<SessionWireScan> {
  for (const candidate of MAIN_WIRE_CANDIDATES) {
    const scan = await scanWireFile(join(sessionDir, candidate));
    if (scan !== undefined) return scan;
  }
  return {};
}

/** `undefined` when the file cannot be read, so the next candidate is tried. */
async function scanWireFile(wirePath: string): Promise<SessionWireScan | undefined> {
  let firstActivityMs: number | undefined;
  let lastActivityMs: number | undefined;

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const record = parsed as { time?: unknown };
    const timeMs = typeof record.time === 'number' ? normalizeTimestampMs(record.time) : undefined;
    if (timeMs !== undefined) {
      firstActivityMs ??= timeMs;
      lastActivityMs = timeMs;
    }
  };

  try {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    // Characters of `pending` already known to contain no newline, so a chunk
    // that ends mid-line is not rescanned from the start (a multi-MB line would
    // otherwise cost O(line²)).
    let scanned = 0;
    const stream = createReadStream(wirePath);
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      pending += decoder.write(chunk);
      let newlineIndex = pending.indexOf('\n', scanned);
      while (newlineIndex !== -1) {
        consumeLine(pending.slice(0, newlineIndex));
        pending = pending.slice(newlineIndex + 1);
        scanned = 0;
        newlineIndex = pending.indexOf('\n', scanned);
      }
      scanned = pending.length;
    }
    // Flush any characters the decoder still holds, then treat a final line
    // without a trailing newline as a record.
    pending += decoder.end();
    if (pending.length > 0) consumeLine(pending);
  } catch {
    return undefined;
  }

  return { firstActivityMs, lastActivityMs };
}

export function normalizeTimestampMs(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000);
}
