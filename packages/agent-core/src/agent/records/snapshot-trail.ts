/**
 * Trimming a `context.snapshot` line's `compactedHistory` debug trail on the
 * raw bytes, before the line is decoded or parsed.
 *
 * The trail is a debug record of pre-compaction history. A wire written before
 * the trail was capped carries every compaction's history in every snapshot,
 * so one snapshot line can be hundreds of megabytes; `JSON.parse` of such a
 * line (and the string it decodes to) exhausted the heap on resume, before any
 * of it was used — restore keeps only the newest entries, and a superseded
 * snapshot's trail is overwritten by the last one's. Cutting the array down
 * here, by scanning bytes (strings and escapes respected, nothing allocated
 * per element), means no more than the kept entries are ever materialized.
 */

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const TRAIL_KEY = Buffer.from('"compactedHistory"', 'utf8');

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/** Index just past the JSON string that starts at `start` (a quote). */
function skipString(buf: Buffer, start: number): number {
  let i = start + 1;
  while (i < buf.length) {
    const byte = buf[i]!;
    if (byte === BACKSLASH) i += 2;
    else if (byte === QUOTE) return i + 1;
    else i += 1;
  }
  return buf.length;
}

/**
 * The top-level `compactedHistory` array of a record line: where its `[` and
 * its closing `]` are, and each element's byte range. Undefined when the line
 * has no such top-level key or is not well formed.
 */
export function locateTrail(
  buf: Buffer,
): { open: number; close: number; elements: Array<readonly [number, number]> } | undefined {
  let depth = 0;
  let i = 0;
  while (i < buf.length) {
    const byte = buf[i]!;
    if (byte === QUOTE) {
      const end = skipString(buf, i);
      if (depth === 1 && end - i === TRAIL_KEY.length && buf.subarray(i, end).equals(TRAIL_KEY)) {
        let j = end;
        while (j < buf.length && isSpace(buf[j]!)) j += 1;
        if (buf[j] === COLON) {
          j += 1;
          while (j < buf.length && isSpace(buf[j]!)) j += 1;
          if (buf[j] !== OPEN_BRACKET) return undefined;
          return scanArray(buf, j);
        }
      }
      i = end;
      continue;
    }
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth += 1;
    else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) depth -= 1;
    i += 1;
  }
  return undefined;
}

function scanArray(
  buf: Buffer,
  open: number,
): { open: number; close: number; elements: Array<readonly [number, number]> } | undefined {
  const elements: Array<readonly [number, number]> = [];
  let depth = 0;
  let elementStart = -1;
  let lastNonSpace = -1;
  let i = open + 1;
  while (i < buf.length) {
    const byte = buf[i]!;
    if (byte === QUOTE) {
      if (depth === 0 && elementStart === -1) elementStart = i;
      i = skipString(buf, i);
      lastNonSpace = i - 1;
      continue;
    }
    if (depth === 0 && (byte === COMMA || byte === CLOSE_BRACKET)) {
      if (elementStart !== -1) elements.push([elementStart, lastNonSpace + 1]);
      elementStart = -1;
      if (byte === CLOSE_BRACKET) return { open, close: i, elements };
      i += 1;
      continue;
    }
    if (!isSpace(byte)) {
      if (depth === 0 && elementStart === -1) elementStart = i;
      lastNonSpace = i;
    }
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth += 1;
    else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) depth -= 1;
    i += 1;
  }
  return undefined;
}

/**
 * The line with its top-level `compactedHistory` cut to the last `keep`
 * entries (0: an empty array). Returns the same buffer when there is nothing
 * to cut or the line is not a well-formed record.
 */
export function trimSnapshotTrail(line: Buffer, keep: number): Buffer {
  const trail = locateTrail(line);
  if (trail === undefined || trail.elements.length <= keep) return line;
  const kept = keep === 0 ? [] : trail.elements.slice(-keep);
  const parts: Buffer[] = [line.subarray(0, trail.open + 1)];
  kept.forEach(([start, end], index) => {
    if (index > 0) parts.push(Buffer.from(','));
    parts.push(line.subarray(start, end));
  });
  parts.push(line.subarray(trail.close));
  return Buffer.concat(parts);
}
