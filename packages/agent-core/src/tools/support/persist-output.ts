/**
 * Saving a tool output too long for the context to a private temp file, so
 * the model gets a preview and the path and reads the rest with the Read tool.
 * Shared by MCP results and fetched pages (Bash keeps its own artifact sink).
 */

import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Save `text` and return the path; a write failure rejects. */
export type PersistOutput = (text: string) => Promise<string | undefined>;

/** Write `text` to `<tmp>/scream-<kind>-output-<uuid>.txt`, readable by the owner only. */
export async function persistToolOutput(kind: string, text: string): Promise<string> {
  const path = join(tmpdir(), `scream-${kind}-output-${randomUUID()}.txt`);
  // `0o600` keeps the output private, `wx` refuses to reuse a name (a
  // pre-created symlink would otherwise redirect the write).
  await writeFile(path, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return path;
}

/** The first `max` characters of `text`, never ending inside a surrogate pair. */
export function previewOf(text: string, max: number): string {
  if (text.length <= max) return text;
  // A code point above U+FFFF starting at the last kept index is a pair the cut would split.
  const splitsPair = (text.codePointAt(max - 1) ?? 0) > 0xffff;
  return text.slice(0, splitsPair ? max - 1 : max);
}
