import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'pathe';

export interface SessionWireScan {
  readonly firstActivityMs?: number | undefined;
  readonly lastActivityMs?: number | undefined;
  readonly lastUserMessageMs?: number | undefined;
  readonly firstUserInput?: string | undefined;
}

/**
 * Scan a session's `wire.jsonl` for activity timestamps and the first user
 * input.
 *
 * The log is append-only and line-delimited, but a long-lived session can grow
 * it to gigabytes, so it is streamed rather than read into a single string: a
 * `StringDecoder` turns each chunk into text without splitting multi-byte
 * characters, complete lines are consumed as they arrive, and only the four
 * aggregated values are retained. Any read failure (including a missing file)
 * yields an empty scan.
 */
export async function scanSessionWire(sessionDir: string): Promise<SessionWireScan> {
  let firstActivityMs: number | undefined;
  let lastActivityMs: number | undefined;
  let lastUserMessageMs: number | undefined;
  let firstUserInput: string | undefined;

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
    const record = parsed as {
      type?: unknown;
      time?: unknown;
      userInput?: unknown;
    };
    const timeMs = typeof record.time === 'number' ? normalizeTimestampMs(record.time) : undefined;
    if (timeMs !== undefined) {
      firstActivityMs ??= timeMs;
      lastActivityMs = timeMs;
    }
    if (record.type === 'turn_begin') {
      if (timeMs !== undefined) {
        lastUserMessageMs = timeMs;
      }
      if (
        firstUserInput === undefined &&
        typeof record.userInput === 'string' &&
        record.userInput.trim().length > 0
      ) {
        firstUserInput = record.userInput;
      }
    }
  };

  try {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    // Characters of `pending` already known to contain no newline, so a chunk
    // that ends mid-line is not rescanned from the start (a multi-MB line would
    // otherwise cost O(line²)).
    let scanned = 0;
    const stream = createReadStream(join(sessionDir, 'wire.jsonl'));
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
    return {};
  }

  return {
    firstActivityMs,
    lastActivityMs,
    lastUserMessageMs,
    firstUserInput,
  };
}

export function normalizeTimestampMs(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000);
}
