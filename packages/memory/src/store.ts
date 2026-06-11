import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'pathe';

import type { MemoryMemo, MemoryMemoRecord, MemoryMemoListResult } from './models.js';
import { toSummary } from './models.js';

const FILE_NAME = 'entries.jsonl';
const TMP_SUFFIX = '.tmp';

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

  private parseLine(rawLine: string, _lineNumber: number): MemoryMemo | undefined {
    if (rawLine.length === 0) return undefined;
    try {
      const record = JSON.parse(rawLine) as Record<string, unknown>;
      if (record['type'] !== 'memory_memo' || !record['entry']) return undefined;
      const entry = record['entry'] as Record<string, unknown>;

      // Migrate v1 → v2 field names
      if (record['version'] === 1 || (entry['userRequirement'] !== undefined && entry['userNeed'] === undefined)) {
        return {
          id: String(entry['id'] ?? ''),
          sourceSessionId: String(entry['sourceSessionId'] ?? ''),
          sourceSessionTitle: typeof entry['sourceSessionTitle'] === 'string' ? entry['sourceSessionTitle'] : undefined,
          userNeed: String(entry['userRequirement'] ?? ''),
          approach: String(entry['solution'] ?? ''),
          outcome: String(entry['completionStatus'] ?? ''),
          whatFailed: String(entry['problemsEncountered'] ?? 'none'),
          whatWorked: 'none',
          extractionSource: (entry['extractionSource'] === 'exit' ? 'exit' : 'compaction') as 'compaction' | 'exit',
          recordedAt: Number(entry['recordedAt'] ?? 0),
        };
      }

      return entry as unknown as MemoryMemo;
    } catch {
      // Skip corrupted lines
      return undefined;
    }
  }
}
