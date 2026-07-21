/**
 * Minimal ZIP reading for the markit document converters (docx/pptx/xlsx/
 * epub are all ZIP containers). Read-only: stored + deflate entries via
 * fflate, which is pure JS and works on every platform.
 *
 * omp frames ZIP manually over node:zlib (their utils/zip.ts also covers tar
 * via Bun.Archive); the converters only ever need `unzip`/`unzipText`, so a
 * fflate-backed equivalent keeps the surface tiny.
 */
import { unzipSync } from 'fflate';

/** A ZIP archive decoded to a `path → bytes` map of its file members. */
export type Unzipped = Record<string, Uint8Array>;

const UTF8_DECODER = new TextDecoder();

/** Read a single ZIP entry as UTF-8 text, or `undefined` when the entry is absent. */
export function unzipText(entries: Unzipped, entryPath: string): string | undefined {
  const data = entries[entryPath];
  return data !== undefined ? UTF8_DECODER.decode(data) : undefined;
}

/** Decode a ZIP archive to a `path → bytes` map. Throws on malformed input. */
export function unzip(bytes: Uint8Array): Unzipped {
  return unzipSync(bytes);
}
