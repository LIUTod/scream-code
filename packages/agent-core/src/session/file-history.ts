/**
 * File history of a session: what the structured write tools (Write, Edit,
 * AstEdit) changed under each user prompt, so undoing prompts can put the
 * files back as well as the conversation.
 *
 * Every change is filed under the latest real user prompt of the main agent
 * (by its context message id), whichever agent made it — a subagent's edits
 * and those of a scheduled turn belong to the prompt the conversation undo
 * would remove with them. For each file the first change under a prompt keeps
 * the content it had before (or that it did not exist); later changes under
 * the same prompt keep nothing more.
 *
 * Restoring is careful about files changed since by someone else: after every
 * write the history notes what the tool left on disk, and a file whose
 * content is no longer that (edited by hand, by a shell command, deleted) is
 * left alone and reported. Files changed only through a shell command are
 * not known here at all.
 *
 * The history lives in `<session>/file-history/` (an index plus one blob per
 * distinct content), so it survives a restart and a resumed session can still
 * take its files back. Files over {@link FILE_HISTORY_MAX_FILE_BYTES} are not
 * copied; undoing them is reported as not possible.
 */

import { createHash } from 'node:crypto';

import type { Jian } from '@scream-code/jian';
import { dirname, join } from 'pathe';

import type { Logger } from '#/logging/types';

import type { FileMutationRecorder } from '../tools/builtin/file/mutation-queue';

/** Files larger than this are not copied: undoing them is reported as not possible. */
export const FILE_HISTORY_MAX_FILE_BYTES = 5 * 1024 * 1024;

interface FileRecord {
  readonly path: string;
  /** False when the change created the file: undoing it deletes the file. */
  readonly existed: boolean;
  /** Content hash of the original, stored as `blobs/<hash>`; absent when it did not exist or was too large. */
  readonly blob?: string | undefined;
  readonly tooLarge?: boolean | undefined;
}

interface PromptEntry {
  readonly promptId: string;
  readonly files: FileRecord[];
}

interface IndexFile {
  readonly version: 1;
  readonly entries: PromptEntry[];
  /** Hash of what a write tool last left in each file; `null` when the file was too large to hash. */
  readonly lastWritten: Record<string, string | null>;
}

export type FileRestoreSkipReason = 'changed' | 'too_large' | 'failed';

export interface FileRestoreResult {
  /** Files put back (rewritten, or deleted when the turn had created them). */
  readonly restored: readonly string[];
  /** Files left as they are, and why. */
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: FileRestoreSkipReason }>;
}

export interface FileHistoryOptions {
  readonly jian: Jian;
  /** The session directory; the history goes to `<dir>/file-history`. */
  readonly sessionDir: string;
  readonly log?: Logger | undefined;
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export class FileHistory implements FileMutationRecorder {
  private readonly jian: Jian;
  private readonly dir: string;
  private readonly log: Logger | undefined;
  private current: string | undefined;
  private promptSource: (() => string | undefined) | undefined;
  private entries: PromptEntry[] = [];
  private lastWritten: Record<string, string | null> = {};
  private loaded: Promise<void> | undefined;
  /** Index writes one after another, so a slow write never overwrites a newer one. */
  private saving: Promise<void> = Promise.resolve();

  constructor(options: FileHistoryOptions) {
    this.jian = options.jian;
    this.dir = join(options.sessionDir, 'file-history');
    this.log = options.log;
  }

  /**
   * The main agent's latest real user prompt, set as it enters the
   * conversation. No I/O: it also runs while a resumed session replays.
   */
  beginPrompt(promptId: string): void {
    this.current = promptId;
  }

  /**
   * Where the current prompt comes from: the main agent's latest real user
   * prompt, read at each change, so a resumed session files its changes right
   * without anything having to be replayed. Wins over {@link beginPrompt}.
   */
  setPromptSource(source: () => string | undefined): void {
    this.promptSource = source;
  }

  private currentPrompt(): string | undefined {
    if (this.promptSource !== undefined) {
      try {
        return this.promptSource();
      } catch {
        return undefined;
      }
    }
    return this.current;
  }

  async beforeMutation(filePath: string): Promise<void> {
    const promptId = this.currentPrompt();
    if (promptId === undefined) return;
    await this.load();
    if (this.entryFor(promptId)?.files.some((file) => file.path === filePath) === true) return;
    const record = await this.capture(filePath);
    // Look the entry up again: another file's capture may have created it meanwhile.
    let entry = this.entryFor(promptId);
    if (entry === undefined) {
      entry = { promptId, files: [] };
      this.entries.push(entry);
    }
    if (entry.files.some((file) => file.path === filePath)) return;
    entry.files.push(record);
    await this.save();
  }

  async afterMutation(filePath: string): Promise<void> {
    if (this.currentPrompt() === undefined) return;
    await this.load();
    const now = await this.hashOf(filePath);
    if (now === undefined) delete this.lastWritten[filePath];
    else this.lastWritten[filePath] = now;
    await this.save();
  }

  /**
   * The files a write tool changed under these prompts, oldest first. A file
   * a tool only touched (an edit that failed and wrote nothing) is left out:
   * what the tool left is what was there before.
   */
  async changedFiles(promptIds: readonly string[]): Promise<string[]> {
    await this.load();
    const ids = new Set(promptIds);
    const earliest = new Map<string, FileRecord>();
    for (const entry of this.entries) {
      if (!ids.has(entry.promptId)) continue;
      for (const file of entry.files) if (!earliest.has(file.path)) earliest.set(file.path, file);
    }
    return [...earliest.values()]
      .filter((file) => {
        const left = this.lastWritten[file.path];
        if (file.existed) return file.tooLarge === true || left !== file.blob;
        return file.path in this.lastWritten;
      })
      .map((file) => file.path);
  }

  /**
   * Put the files changed under these prompts back as they were before the
   * first of them, and forget those prompts. A file changed since by anyone
   * but the write tools is left as it is.
   */
  async restore(promptIds: readonly string[]): Promise<FileRestoreResult> {
    await this.load();
    const ids = new Set(promptIds);
    // The earliest record of each file is its state before all of these prompts.
    const earliest = new Map<string, FileRecord>();
    for (const entry of this.entries) {
      if (!ids.has(entry.promptId)) continue;
      for (const file of entry.files) if (!earliest.has(file.path)) earliest.set(file.path, file);
    }
    const restored: string[] = [];
    const skipped: Array<{ path: string; reason: FileRestoreSkipReason }> = [];
    for (const [path, record] of earliest) {
      try {
        const now = await this.hashOf(path);
        // Already as it was (a write that failed, or changed back): nothing to do.
        if (record.existed ? now === record.blob && now !== undefined : now === undefined) continue;
        if (record.tooLarge === true) {
          skipped.push({ path, reason: 'too_large' });
          continue;
        }
        // Someone else changed it after the last write: their version stays.
        if (!(path in this.lastWritten) || this.lastWritten[path] !== (now ?? null)) {
          skipped.push({ path, reason: 'changed' });
          continue;
        }
        if (record.existed) {
          const data = await this.jian.readBytes(join(this.dir, 'blobs', record.blob!));
          await this.jian.mkdir(dirname(path), { parents: true, existOk: true });
          await this.jian.writeBytes(path, data);
          this.lastWritten[path] = record.blob!;
        } else {
          await this.jian.removeFile(path);
          delete this.lastWritten[path];
        }
        restored.push(path);
      } catch (error) {
        this.log?.warn('file history: could not restore a file', { path, error: String(error) });
        skipped.push({ path, reason: 'failed' });
      }
    }
    await this.forget(ids);
    return { restored, skipped };
  }

  /** Forget these prompts without touching any file (the conversation alone was undone). */
  async discard(promptIds: readonly string[]): Promise<void> {
    await this.load();
    await this.forget(new Set(promptIds));
  }

  private entryFor(promptId: string): PromptEntry | undefined {
    return this.entries.find((entry) => entry.promptId === promptId);
  }

  private async forget(ids: ReadonlySet<string>): Promise<void> {
    const before = this.entries.length;
    const dropped = this.entries.filter((entry) => ids.has(entry.promptId));
    this.entries = this.entries.filter((entry) => !ids.has(entry.promptId));
    if (this.entries.length === before) return;
    await this.save();
    // Blobs no longer referenced by any entry.
    const kept = new Set(this.entries.flatMap((entry) => entry.files.map((file) => file.blob)));
    for (const blob of new Set(dropped.flatMap((entry) => entry.files.map((file) => file.blob)))) {
      if (blob === undefined || kept.has(blob)) continue;
      try {
        await this.jian.removeFile(join(this.dir, 'blobs', blob));
      } catch {
        // An orphan blob only takes space.
      }
    }
  }

  /** What the file holds now: its hash, `null` when too large to hash, undefined when it does not exist. */
  private async hashOf(path: string): Promise<string | null | undefined> {
    try {
      const info = await this.jian.stat(path);
      if (info.stSize > FILE_HISTORY_MAX_FILE_BYTES) return null;
      return sha256(await this.jian.readBytes(path));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private async capture(path: string): Promise<FileRecord> {
    let size: number;
    try {
      size = (await this.jian.stat(path)).stSize;
    } catch (error) {
      if (isMissing(error)) return { path, existed: false };
      throw error;
    }
    if (size > FILE_HISTORY_MAX_FILE_BYTES) return { path, existed: true, tooLarge: true };
    const data = await this.jian.readBytes(path);
    const blob = sha256(data);
    const blobPath = join(this.dir, 'blobs', blob);
    await this.jian.mkdir(join(this.dir, 'blobs'), { parents: true, existOk: true });
    let stored = false;
    try {
      stored = (await this.jian.stat(blobPath)).stSize === data.length;
    } catch {
      stored = false;
    }
    if (!stored) await this.jian.writeBytes(blobPath, data);
    return { path, existed: true, blob };
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const parsed = JSON.parse(await this.jian.readText(join(this.dir, 'index.json'))) as Partial<IndexFile>;
        if (parsed.version === 1 && Array.isArray(parsed.entries)) {
          this.entries = parsed.entries.filter(
            (entry): entry is PromptEntry => typeof entry?.promptId === 'string' && Array.isArray(entry.files),
          );
          this.lastWritten = typeof parsed.lastWritten === 'object' && parsed.lastWritten !== null ? parsed.lastWritten : {};
        }
      } catch (error) {
        if (!isMissing(error)) this.log?.warn('file history: unreadable index, starting empty', { error: String(error) });
      }
    })();
    return this.loaded;
  }

  private save(): Promise<void> {
    const index: IndexFile = { version: 1, entries: this.entries, lastWritten: this.lastWritten };
    const text = JSON.stringify(index);
    this.saving = this.saving.then(async () => {
      try {
        await this.jian.mkdir(this.dir, { parents: true, existOk: true });
        await this.jian.writeTextAtomic(join(this.dir, 'index.json'), text);
      } catch (error) {
        this.log?.warn('file history: could not save the index', { error: String(error) });
      }
    });
    return this.saving;
  }
}
