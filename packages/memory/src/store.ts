import { mkdir, open, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'pathe';

import type { MemoryMemo, MemoryMemoRecord, MemoryMemoListResult } from './models.js';
import { toSummary } from './models.js';

const FILE_NAME = 'entries.jsonl';
const TMP_SUFFIX = '.tmp';
const MIGRATION_MARKER = '.migrated';

export class MemoryMemoStore {
  private readonly filePath: string;

  constructor(projectDir: string) {
    this.filePath = join(projectDir, 'memory', FILE_NAME);
  }

  /** Iterate all memo records from the JSONL file. */
  async *read(): AsyncIterable<MemoryMemo> {
    let stream;
    try {
      stream = createReadStream(this.filePath, { encoding: 'utf8' });
    } catch {
      return; // file doesn't exist or is unreadable — no entries
    }

    let line = '';
    let lineNumber = 0;
    try {
      for await (const chunk of stream) {
        line += chunk;
        let newlineIndex = line.indexOf('\n');
        while (newlineIndex !== -1) {
          const rawLine = line.slice(0, newlineIndex).replace(/\r$/, '');
          line = line.slice(newlineIndex + 1);
          lineNumber++;

          const memo = this.parseLine(rawLine, lineNumber);
          if (memo !== undefined) yield memo;

          newlineIndex = line.indexOf('\n');
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  /** Append a memo. */
  async append(entry: MemoryMemo): Promise<void> {
    const record: MemoryMemoRecord = {
      type: 'memory_memo',
      version: 2,
      entry,
    };
    await this.ensureDir();
    const fh = await open(this.filePath, 'a');
    try {
      await fh.writeFile(JSON.stringify(record) + '\n', 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  /** Delete a memo by id (rewrites the file without it). */
  async delete(id: string): Promise<boolean> {
    const entries: MemoryMemo[] = [];
    for await (const memo of this.read()) {
      if (memo.id !== id) entries.push(memo);
    }

    if (entries.length === 0) {
      try {
        await unlink(this.filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return true;
    }

    try {
      const tmpPath = this.filePath + TMP_SUFFIX;
      const fh = await open(tmpPath, 'w');
      try {
        for (const entry of entries) {
          const record: MemoryMemoRecord = {
            type: 'memory_memo',
            version: 2,
            entry,
          };
          await fh.writeFile(JSON.stringify(record) + '\n', 'utf8');
        }
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmpPath, this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  /** Get a single memo by ID. */
  async get(id: string): Promise<MemoryMemo | undefined> {
    for await (const memo of this.read()) {
      if (memo.id === id) return memo;
    }
    return undefined;
  }

  /** List memos with optional search and limit. */
  async list(options?: {
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<MemoryMemoListResult> {
    const search = options?.search?.toLowerCase();
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const all: MemoryMemo[] = [];
    for await (const memo of this.read()) {
      all.push(memo);
    }

    // Sort by recordedAt desc (newest first)
    all.sort((a, b) => b.recordedAt - a.recordedAt);

    let filtered = all;
    if (search) {
      filtered = all.filter(
        (m) =>
          m.userNeed.toLowerCase().includes(search) ||
          m.approach.toLowerCase().includes(search) ||
          m.whatFailed.toLowerCase().includes(search) ||
          m.whatWorked.toLowerCase().includes(search) ||
          (m.sourceSessionTitle ?? '').toLowerCase().includes(search),
      );
    }

    const total = filtered.length;
    const memos = filtered.slice(offset, offset + limit).map(toSummary);
    return { memos, total };
  }

  private async ensureDir(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
  }

  /** @internal */
  parseLine(rawLine: string, _lineNumber: number): MemoryMemo | undefined {
    if (rawLine.length === 0) return undefined;
    try {
      const record = JSON.parse(rawLine) as Record<string, unknown>;
      if (record['type'] !== 'memory_memo' || !record['entry']) return undefined;
      const entry = record['entry'] as Record<string, unknown>;

      // Migrate v1 → v2 field names
      if (record['version'] === 1 || (entry['userRequirement'] !== undefined && entry['userNeed'] === undefined)) {
        const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
        return {
          id: str(entry['id']),
          sourceSessionId: str(entry['sourceSessionId']),
          sourceSessionTitle: str(entry['sourceSessionTitle'], undefined as unknown as string),
          userNeed: str(entry['userRequirement']),
          approach: str(entry['solution']),
          outcome: str(entry['completionStatus']),
          whatFailed: str(entry['problemsEncountered'], 'none'),
          whatWorked: 'none',
          extractionSource: (entry['extractionSource'] === 'exit' ? 'exit' : 'compaction') as 'compaction' | 'exit',
          recordedAt: typeof entry['recordedAt'] === 'number' ? entry['recordedAt'] : 0,
        };
      }

      return entry as unknown as MemoryMemo;
    } catch {
      // Skip corrupted lines
      return undefined;
    }
  }

  /**
   * One-time migration from per-workDir memory stores to a global store.
   * Reads `<screamHomeDir>/sessions/<workDirKey>/memory/entries.jsonl`
   * and appends valid entries to `<screamHomeDir>/memory/entries.jsonl`.
   * Deletes the legacy per-session memory files afterwards and writes a marker
   * file so the migration only runs once.
   */
  static async migrateLegacyStores(screamHomeDir: string): Promise<void> {
    const target = new MemoryMemoStore(screamHomeDir);
    const markerPath = join(screamHomeDir, 'memory', MIGRATION_MARKER);

    try {
      await stat(markerPath);
      return; // already migrated
    } catch {
      // continue with migration
    }

    const sessionsDir = join(screamHomeDir, 'sessions');
    let sessionEntries: string[];
    try {
      sessionEntries = await readdir(sessionsDir, { withFileTypes: true })
        .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name));
    } catch {
      await writeFile(markerPath, '', 'utf8').catch(() => {});
      return;
    }

    const migratedIds = new Set<string>();
    for await (const memo of target.read()) {
      migratedIds.add(memo.id);
    }

    let migratedCount = 0;
    const legacyPaths: string[] = [];
    for (const sessionKey of sessionEntries) {
      const legacyPath = join(sessionsDir, sessionKey, 'memory', FILE_NAME);
      let stream;
      try {
        stream = createReadStream(legacyPath, { encoding: 'utf8' });
      } catch {
        continue;
      }

      // Swallow async ENOENT errors when the legacy file does not exist.
      stream.on('error', () => {});

      let line = '';
      let hadContent = false;
      try {
        for await (const chunk of stream) {
          line += chunk;
          let newlineIndex = line.indexOf('\n');
          while (newlineIndex !== -1) {
            const rawLine = line.slice(0, newlineIndex).replace(/\r$/, '');
            line = line.slice(newlineIndex + 1);
            newlineIndex = line.indexOf('\n');

            const memo = target.parseLine(rawLine, 0);
            if (memo === undefined || migratedIds.has(memo.id)) continue;
            await target.append(memo);
            migratedIds.add(memo.id);
            migratedCount++;
            hadContent = true;
          }
        }
      } catch {
        continue;
      }

      // Track the file for deletion only if we successfully read its stream.
      // We delete regardless of whether any new entries were migrated; the
      // global store is now the source of truth.
      legacyPaths.push(legacyPath);
    }

    // Delete legacy per-session memory files and empty memory directories.
    for (const legacyPath of legacyPaths) {
      await unlink(legacyPath).catch(() => {});
      await rmdir(dirname(legacyPath)).catch(() => {});
    }

    await writeFile(markerPath, `${migratedCount}\n`, 'utf8').catch(() => {});
  }
}
