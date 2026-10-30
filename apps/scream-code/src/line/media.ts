/**
 * Inbound media plumbing shared by both channels.
 *
 * Images travel inline (data URL → `image_url` prompt part), so they need no
 * disk. Everything else is written under the Scream home — never into the
 * user's working directory, which may be a git repo — and the model is handed
 * the absolute path.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveScreamHome } from '@scream-code/scream-code-sdk';

/** Hard cap for one inbound image; the reference uses the same order of size. */
export const MAX_INBOUND_IMAGE_BYTES = 8 * 1024 * 1024;
/** Cap for one inbound file written to disk. */
export const MAX_INBOUND_FILE_BYTES = 32 * 1024 * 1024;
/** Images per turn: phone albums are bursty, and each one costs vision tokens. */
export const MAX_IMAGES_PER_TURN = 4;

export interface LineImageAttachment {
  readonly mime: string;
  readonly data: Buffer;
}

/** Sniffs the image type from magic bytes; falls back to the declared hint. */
export function sniffImageMime(data: Buffer, hint?: string): string {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && data.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  if (hint !== undefined && hint.startsWith('image/')) return hint;
  return 'image/png';
}

/** Strips path separators and control characters from a channel-supplied name. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.replaceAll(/[\u0000-\u001F<>:"|?*]/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'file';
}

/**
 * Writes one inbound file under `<scream-home>/line/inbox/<sessionKey>/` and
 * returns its absolute path. The directory is created on demand; the session
 * key keeps channels and chats apart.
 */
export async function saveInboundFile(
  sessionKey: string,
  name: string,
  data: Buffer,
): Promise<string> {
  if (data.length > MAX_INBOUND_FILE_BYTES) {
    throw new Error(`inbound file too large: ${data.length} bytes`);
  }
  const dir = join(resolveScreamHome(), 'line', 'inbox', sessionKey);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `${Date.now()}-${sanitizeFileName(name)}`);
  await writeFile(target, data, { mode: 0o600 });
  return target;
}
