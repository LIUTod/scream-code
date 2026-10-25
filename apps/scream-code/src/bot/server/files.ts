/**
 * Files are rooted at the selected thread's fixed workspace, or the Bot's
 * default workspace when no thread was selected. Lexical and realpath checks
 * prevent paths and symlinks from escaping that single root.
 */
import { lstat, mkdir, open, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { BotStore } from './store';

export const MAX_FILE_READ = 256 * 1024;
export const MAX_FILE_WRITE = 2 * 1024 * 1024;
export const MAX_ATTACHMENT = 25 * 1024 * 1024;

const ATTACHMENT_DIR = '.scream-attachments';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'target', '.turbo', ATTACHMENT_DIR]);

export class FileAccessError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly type: 'file' | 'dir';
  readonly size: number;
  readonly mtime: number;
}

export interface FileListResult {
  readonly path: string;
  readonly entries: readonly FileEntry[];
}

export interface FileReadResult {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface AttachmentUpload {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SavedAttachment {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly mime: string;
}

/**
 * Keep only the leaf name, and only characters every filesystem accepts.
 * Letters and digits are kept in any script; separators and control characters
 * become underscores so the stored path is stable and saf01e to quote.
 */
function safeAttachmentName(raw: string): string {
  const leaf = basename(raw.replaceAll('\\', '/'));
  const cleaned = leaf.replaceAll(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+/, '').slice(0, 120);
  return cleaned.length === 0 ? 'file' : cleaned;
}

export class BotFiles {
  constructor(private readonly store: BotStore) {}

  /**
   * Save one upload into several workspaces under the same relative path.
   *
   * A room hands the same attachment to every addressed Bot, so every one of
   * them must be able to open it from its own workspace.
   */
  async saveAttachmentForBots(
    botIds: readonly string[],
    upload: AttachmentUpload,
  ): Promise<SavedAttachment> {
    if (botIds.length === 0) throw new FileAccessError(409, 'No Bot can receive this file');
    if (upload.size <= 0) throw new FileAccessError(400, 'Empty attachment');
    if (upload.size > MAX_ATTACHMENT) throw new FileAccessError(413, 'Attachment is too large');
    const name = safeAttachmentName(upload.name);
    const id = randomUUID();
    const path = `${ATTACHMENT_DIR}/${id}-${name}`;
    const body = Buffer.from(await upload.arrayBuffer());
    for (const botId of botIds) {
      const { abs } = await this.resolve(botId, path, { write: true });
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, body, { flag: 'wx' });
    }
    return {
      id,
      name,
      path,
      size: upload.size,
      mime: upload.type.length > 0 ? upload.type : 'application/octet-stream',
    };
  }

  /**
   * Save an uploaded file inside the Bot workspace.
   *
   * The file name is reduced to a leaf and the directory gets a unique prefix,
   * so an upload can neither overwrite a workspace file nor escape the root.
   */
  async saveAttachment(
    botId: string,
    upload: AttachmentUpload,
    options: { readonly threadId?: string } = {},
  ): Promise<SavedAttachment> {
    if (upload.size <= 0) throw new FileAccessError(400, 'Empty attachment');
    if (upload.size > MAX_ATTACHMENT) throw new FileAccessError(413, 'Attachment is too large');
    const name = safeAttachmentName(upload.name);
    const id = randomUUID();
    const path = `${ATTACHMENT_DIR}/${id}-${name}`;
    const { abs } = await this.resolve(botId, path, { write: true, threadId: options.threadId });
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.from(await upload.arrayBuffer()), { flag: 'wx' });
    return {
      id,
      name,
      path,
      size: upload.size,
      mime: upload.type.length > 0 ? upload.type : 'application/octet-stream',
    };
  }

  async list(botId: string, requestedPath?: string, threadId?: string): Promise<FileListResult> {
    const { abs, root } = await this.resolve(botId, requestedPath, { threadId });
    const rootReal = (await tryRealpath(root)) ?? root;
    const info = await stat(abs).catch(() => null);
    if (info === null) throw new FileAccessError(404, `Path not found: ${abs}`);
    if (!info.isDirectory()) throw new FileAccessError(400, `Not a directory: ${abs}`);
    let entries: Dirent[];
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      throw new FileAccessError(404, `Cannot read directory: ${abs}`);
    }
    const out: FileEntry[] = [];
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = join(abs, entry.name);
      try {
        const fullReal = await tryRealpath(full);
        if (fullReal === null || !isContained(rootReal, fullReal)) continue;
        const info = await stat(full);
        out.push({
          name: entry.name,
          path: full,
          type: info.isDirectory() ? 'dir' : 'file',
          size: info.isDirectory() ? 0 : info.size,
          mtime: info.mtimeMs,
        });
      } catch {
        // Skip entries that fail the gate (broken or escaping symlinks).
      }
    }
    out.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
    );
    return { path: abs, entries: out };
  }

  async read(botId: string, requestedPath?: string, threadId?: string): Promise<FileReadResult> {
    const { abs } = await this.resolve(botId, requestedPath, { threadId });
    const info = await stat(abs).catch(() => null);
    if (info === null) throw new FileAccessError(404, `File not found: ${abs}`);
    if (info.isDirectory()) throw new FileAccessError(400, `Is a directory: ${abs}`);
    const handle = await open(abs, 'r');
    try {
      // Read only the preview plus one byte, including if the file grows after stat.
      const buffer = Buffer.alloc(MAX_FILE_READ + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const truncated = length > MAX_FILE_READ;
      const decoder = new StringDecoder('utf8');
      const content = decoder.write(buffer.subarray(0, Math.min(length, MAX_FILE_READ))) +
        (truncated ? '' : decoder.end());
      return { path: abs, content, truncated };
    } finally {
      await handle.close();
    }
  }

  /** Classify a path so the REST layer can choose list vs read. */
  async kind(botId: string, requestedPath?: string, threadId?: string): Promise<'file' | 'dir'> {
    const { abs } = await this.resolve(botId, requestedPath, { threadId });
    const info = await stat(abs).catch(() => null);
    if (info === null) throw new FileAccessError(404, `Path not found: ${abs}`);
    return info.isDirectory() ? 'dir' : 'file';
  }

  async write(
    botId: string,
    requestedPath: string | undefined,
    content: string,
    threadId?: string,
  ): Promise<{ path: string; bytes: number }> {
    if (requestedPath === undefined || requestedPath.trim().length === 0) {
      throw new FileAccessError(400, 'File path is required');
    }
    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_WRITE) {
      throw new FileAccessError(413, 'File is too large to write');
    }
    const { abs } = await this.resolve(botId, requestedPath, { write: true, threadId });
    const info = await stat(abs).catch(() => null);
    if (info !== null && info.isDirectory()) {
      throw new FileAccessError(400, `Is a directory: ${abs}`);
    }
    try {
      await writeFile(abs, content, 'utf-8');
    } catch (error) {
      throw new FileAccessError(400, `Cannot write file: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { path: abs, bytes: Buffer.byteLength(content, 'utf-8') };
  }

  /** Resolve a client path inside the bot workspace; throws 403/404 on escape. */
  private async resolve(
    botId: string,
    requestedPath: string | undefined,
    options: { readonly write?: boolean; readonly threadId?: string | undefined } = {},
  ): Promise<{ abs: string; root: string }> {
    const bot = this.store.getBot(botId);
    if (bot === undefined) throw new FileAccessError(404, `Bot not found: ${botId}`);
    const thread = options.threadId === undefined ? undefined : this.store.getThread(options.threadId);
    if (options.threadId !== undefined && (thread === undefined || thread.botId !== botId)) {
      throw new FileAccessError(404, 'Thread not found for this Bot');
    }
    const root = resolve(thread?.workspace ?? bot.workspace);
    const rootReal = (await tryRealpath(root)) ?? root;
    const raw = requestedPath === undefined || requestedPath.length === 0 ? '.' : requestedPath;
    const normalized = raw.replaceAll('\\', '/');
    const abs = resolve(isAbsolute(normalized) ? normalized : join(root, normalized));

    if (!isContained(root, abs)) {
      throw new FileAccessError(403, 'Path is outside the bot workspace');
    }
    if (options.write === true) {
      // For a new file, realpath the parent directory — the file need not exist.
      const parentReal = (await tryRealpath(resolve(abs, '..'))) ?? (await tryRealpath(abs));
      if (parentReal !== null) {
        if (!isContained(rootReal, parentReal)) {
          throw new FileAccessError(403, 'Path is outside the bot workspace');
        }
      }
      const existingReal = await tryRealpath(abs);
      const leaf = await lstat(abs).catch(() => null);
      // A dangling symlink is not a new file: writeFile would follow its target.
      if ((leaf?.isSymbolicLink() && existingReal === null) ||
          (existingReal !== null && !isContained(rootReal, existingReal))) {
        throw new FileAccessError(403, 'Path is outside the bot workspace');
      }
      return { abs, root };
    }
    const absReal = await tryRealpath(abs);
    if (absReal === null) throw new FileAccessError(404, `Path not found: ${abs}`);
    if (!isContained(rootReal, absReal)) {
      throw new FileAccessError(403, 'Path is outside the bot workspace');
    }
    return { abs, root };
  }
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

async function tryRealpath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}
