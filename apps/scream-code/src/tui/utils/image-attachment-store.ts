/**
 * Registry for media pasted into the input box.
 *
 * Each paste produces an `ImageAttachment` with an auto-incrementing id
 * or `VideoAttachment` with a human-readable placeholder (`[image #1
 * (640×480)]` / `[video #2 sample.mov]`). The placeholder is what the
 * user sees in the input field; on submit, `extractMediaAttachments`
 * walks the text and expands image placeholders to image content parts
 * and video placeholders to file-path tags for `ReadMediaFile`.
 *
 * Scope is per-`ScreamTUI` instance. Reloads (`/new`, `/clear`,
 * session switch) call `clear()` so ids restart from 1 and stale
 * prompt attachments are dropped. We intentionally do NOT persist
 * attachments across sessions — coding-agent doesn't either, and
 * `--resume` wouldn't know how to materialize the files anyway.
 */
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ImageAttachment {
  readonly id: number;
  readonly kind: 'image';
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  /** Rendered placeholder string, e.g. `[image #1 (640×480)]`. */
  readonly placeholder: string;
  /**
   * On-disk path when known (file paste) or materialized for non-vision
   * delivery. Used for `<image path="…">` tags so text-only models can
   * still operate on the file (zip/move) without multimodal input.
   */
  sourcePath?: string;
}

export interface VideoAttachment {
  readonly id: number;
  readonly kind: 'video';
  readonly mime: string;
  readonly filename: string;
  readonly sourcePath: string;
  readonly label: string;
  /** Rendered placeholder string, e.g. `[video #1 sample.mov]`. */
  readonly placeholder: string;
}

export type MediaAttachment = ImageAttachment | VideoAttachment;

/** Temp-file basename prefix used by path-mode image materialization. */
export const TEMP_ATTACHMENT_PREFIX = 'scream-attachment-';

export class ImageAttachmentStore {
  private nextId = 1;
  private readonly byId = new Map<number, MediaAttachment>();

  addImage(
    bytes: Uint8Array,
    mime: string,
    width: number,
    height: number,
    sourcePath?: string,
  ): ImageAttachment {
    const id = this.nextId;
    this.nextId += 1;
    const attachment: ImageAttachment = {
      id,
      kind: 'image',
      bytes,
      mime,
      width,
      height,
      placeholder: formatPlaceholder(id, width, height),
      ...(sourcePath !== undefined && sourcePath.length > 0 ? { sourcePath } : {}),
    };
    this.byId.set(id, attachment);
    return attachment;
  }

  addVideo(mime: string, sourcePath: string, filename?: string | undefined): VideoAttachment {
    const id = this.nextId;
    this.nextId += 1;
    const normalizedFilename = basenameLike(
      filename !== undefined && filename !== '' ? filename : sourcePath,
    );
    const label = sanitizeVideoLabel(normalizedFilename.length > 0 ? normalizedFilename : mime);
    const attachment: VideoAttachment = {
      id,
      kind: 'video',
      mime,
      filename: normalizedFilename,
      sourcePath,
      label,
      placeholder: formatVideoPlaceholder(id, label),
    };
    this.byId.set(id, attachment);
    return attachment;
  }

  get(id: number): MediaAttachment | undefined {
    return this.byId.get(id);
  }

  clear(): void {
    const tempBase = join(tmpdir(), TEMP_ATTACHMENT_PREFIX);
    for (const attachment of this.byId.values()) {
      if (attachment.kind !== 'image') continue;
      const path = attachment.sourcePath;
      if (path !== undefined && path.startsWith(tempBase)) {
        try {
          unlinkSync(path);
        } catch {
          // best-effort cleanup — session teardown must not fail
        }
      }
    }
    this.byId.clear();
    this.nextId = 1;
  }

  size(): number {
    return this.byId.size;
  }
}

export function formatPlaceholder(id: number, width: number, height: number): string {
  return `[image #${String(id)} (${String(width)}×${String(height)})]`;
}

export function formatVideoPlaceholder(id: number, label: string): string {
  return `[video #${String(id)} ${sanitizeVideoLabel(label)}]`;
}

function sanitizeVideoLabel(raw: string): string {
  let label = '';
  for (const char of raw) {
    const code = char.codePointAt(0);
    label +=
      code === undefined || code < 0x20 || code === 0x7f || char === '[' || char === ']'
        ? '_'
        : char;
  }
  label = label.trim();
  return label.length > 0 ? label : 'video';
}

function basenameLike(raw: string): string {
  const parts = raw.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.at(-1) ?? raw;
}
