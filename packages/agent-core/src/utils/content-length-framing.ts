/**
 * Content-Length message framing shared by LSP and DAP.
 *
 * Both protocols put a header block followed by a JSON body on the same stdio
 * pipe:
 *
 *     Content-Length: <bytes>\r\n
 *     \r\n
 *     <json>
 *
 * `Content-Length` counts UTF-8 bytes, while JS strings are UTF-16 code
 * units, so slicing by `string.length` misaligns every message carrying
 * multi-byte characters (Chinese diagnostics, emoji). The parser here walks
 * code points, sums their UTF-8 width, and never splits a multi-byte
 * character mid-sequence, so `JSON.parse` never sees half a character.
 *
 * The module is deliberately protocol-agnostic: it moves opaque JSON values
 * and knows nothing about JSON-RPC or DAP message shapes.
 */

import type { Writable } from 'node:stream';

/** Write one framed message to `stream`. No-op payloads are not filtered. */
export function writeFrame(stream: Writable, message: unknown): void {
  const payload = JSON.stringify(message);
  stream.write(`Content-Length: ${String(Buffer.byteLength(payload, 'utf8'))}\r\n\r\n${payload}`);
}

export interface FrameParser {
  /** Feed one stdout chunk; every complete message is delivered via `onMessage`. */
  push(chunk: Buffer | string): void;
  /** Drop buffered bytes (client restart / teardown). */
  reset(): void;
}

/**
 * Build a stateful parser over a byte stream. Malformed bodies are dropped
 * silently: both protocols treat a garbled frame as noise from the peer
 * rather than a reason to tear the session down.
 */
export function createFrameParser(onMessage: (message: unknown) => void): FrameParser {
  let buffer = '';
  let bufferBytes = 0;
  let contentLength = -1;

  return {
    push(chunk: Buffer | string): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      buffer += text;
      bufferBytes += Buffer.byteLength(text, 'utf8');

      while (true) {
        if (contentLength === -1) {
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd === -1) return;
          const header = buffer.slice(0, headerEnd);
          const match = /Content-Length:\s*(\d+)/i.exec(header);
          const headerEndChar = headerEnd + 4;
          const droppedHeader = buffer.slice(0, headerEndChar);
          bufferBytes -= Buffer.byteLength(droppedHeader, 'utf8');
          buffer = buffer.slice(headerEndChar);
          if (match === null) {
            // Header block without a length: skip it and resync on the next.
            continue;
          }
          contentLength = Number(match[1]);
        }

        if (bufferBytes < contentLength) return;
        const { text: body, consumedChars, consumedBytes } = sliceByBytes(buffer, contentLength);
        buffer = buffer.slice(consumedChars);
        bufferBytes -= consumedBytes;
        contentLength = -1;

        try {
          onMessage(JSON.parse(body) as unknown);
        } catch {
          // Ignore malformed messages.
        }
      }
    },

    reset(): void {
      buffer = '';
      bufferBytes = 0;
      contentLength = -1;
    },
  };
}

function byteLengthOfCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Slice `targetBytes` worth of UTF-8 from the head of `text`, without
 * splitting a multi-byte character.
 */
function sliceByBytes(
  text: string,
  targetBytes: number,
): { readonly text: string; readonly consumedChars: number; readonly consumedBytes: number } {
  let chars = 0;
  let bytes = 0;
  while (chars < text.length && bytes < targetBytes) {
    const codePoint = text.codePointAt(chars);
    if (codePoint === undefined) break;
    const charLen = codePoint > 0xffff ? 2 : 1;
    const charBytes = byteLengthOfCodePoint(codePoint);
    if (bytes + charBytes > targetBytes) break;
    bytes += charBytes;
    chars += charLen;
  }
  return { text: text.slice(0, chars), consumedChars: chars, consumedBytes: bytes };
}
