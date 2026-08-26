import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'pathe';

import { syncDir } from '../../utils/fs';
import type { BlobStore } from './blobref';
import { AGENT_WIRE_PROTOCOL_VERSION } from './migration';
import { type AgentRecord, type AgentRecordPersistence } from './types';

/**
 * Record types whose state is fully captured by a `context.snapshot` record.
 * Canonical definition — records/index.ts imports it for the restore
 * fast-path. It also drives the parse-skipping fast path in `read()` below:
 * serialized lines of these types that predate the last snapshot are never
 * JSON.parse'd.
 */
export const SNAPSHOT_FOLDED_CONTEXT_TYPES: ReadonlySet<string> = new Set([
  'context.append_message',
  'context.append_loop_event',
  'context.apply_compaction',
  'micro_compaction.apply',
  'full_compaction.complete',
]);

/**
 * Serialized-line prefix of a context.snapshot record. Persisted records
 * always serialize "type" as the first key (locked by test), so a startsWith
 * probe is exact — a false positive would require an entire line to start
 * with this JSON prefix, which no other record (or any message content, whose
 * line starts with its own record "type") can produce.
 */
const SNAPSHOT_RECORD_LINE_PREFIX = '{"type":"context.snapshot"';

/** Line prefixes of the folded record types, derived from the set above. */
const SNAPSHOT_FOLDED_LINE_PREFIXES: readonly string[] = [...SNAPSHOT_FOLDED_CONTEXT_TYPES].map(
  (type) => `{"type":"${type}"`,
);

function isSnapshotFoldedLine(line: string): boolean {
  return SNAPSHOT_FOLDED_LINE_PREFIXES.some((prefix) => line.startsWith(prefix));
}

/** A buffered physical line from the wire file. */
interface WireLine {
  readonly text: string;
  readonly lineNumber: number;
  readonly allowTruncated: boolean;
}

export interface FileSystemAgentRecordPersistenceOptions {
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly blobStore?: BlobStore | undefined;
}

export interface InMemoryAgentRecordPersistenceOptions {
  readonly onRecord?: ((record: AgentRecord) => void) | undefined;
}

export class InMemoryAgentRecordPersistence implements AgentRecordPersistence {
  readonly records: AgentRecord[] = [];

  constructor(
    records: readonly AgentRecord[] = [],
    private readonly options: InMemoryAgentRecordPersistenceOptions = {},
  ) {
    this.records.push(...records);
  }

  async *read(): AsyncIterable<AgentRecord> {
    for (const record of this.records) {
      yield record;
    }
  }

  append(input: AgentRecord): void {
    this.records.push(input);
    this.options.onRecord?.(input);
  }

  rewrite(records: readonly AgentRecord[]): void {
    this.records.splice(0, this.records.length, ...records);
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}
}

export class FileSystemAgentRecordPersistence implements AgentRecordPersistence {
  private readonly pendingRecords: AgentRecord[] = [];
  private shouldClear = false;
  private directorySynced = false;
  private flushPromise: Promise<void> | undefined;
  private error: unknown;

  constructor(
    private readonly filePath: string,
    private readonly options: FileSystemAgentRecordPersistenceOptions = {},
  ) {}

  async *read(): AsyncIterable<AgentRecord> {
    await this.flush();

    // Phase 1: buffer raw lines WITHOUT parsing, tracking the last
    // context.snapshot line via the cheap prefix probe. On long sessions
    // JSON.parse dominates; buffering strings is cheap in comparison, and the
    // records array built downstream (records/index.ts replay) already holds
    // the full parsed result in memory anyway.
    const lines: WireLine[] = [];
    let lastSnapshotLineNumber = -1;
    let pending = '';
    let lineNumber = 0;
    const stream = createReadStream(this.filePath, { encoding: 'utf8' });
    try {
      for await (const chunk of stream) {
        pending += chunk;
        let newlineIndex = pending.indexOf('\n');
        while (newlineIndex !== -1) {
          let rawLine = pending.slice(0, newlineIndex);
          pending = pending.slice(newlineIndex + 1);
          lineNumber++;
          if (rawLine.endsWith('\r')) rawLine = rawLine.slice(0, -1);
          if (rawLine.startsWith(SNAPSHOT_RECORD_LINE_PREFIX)) {
            lastSnapshotLineNumber = lineNumber;
          }
          lines.push({ text: rawLine, lineNumber, allowTruncated: false });
          newlineIndex = pending.indexOf('\n');
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw error;
    }
    if (pending.length > 0) {
      lineNumber++;
      // Unterminated trailing line — the last write may have crashed
      // mid-flush; parsing it tolerates truncation (see parseRecordLine).
      lines.push({ text: pending, lineNumber, allowTruncated: true });
    }

    // Parse-skipping is only safe when no wire migration is needed: a version
    // mismatch triggers migrations/rewrite that must see EVERY record, so
    // old/new-version files fall back to full parsing. The version lives in
    // the first (metadata) line.
    let skipFoldedBeforeSnapshot = false;
    if (lines.length > 0) {
      try {
        const header = JSON.parse(lines[0]!.text) as { protocol_version?: unknown };
        skipFoldedBeforeSnapshot = header.protocol_version === AGENT_WIRE_PROTOCOL_VERSION;
      } catch {
        skipFoldedBeforeSnapshot = false; // header error re-thrown in phase 2
      }
    }

    // Phase 2: parse. Folded records predating the last snapshot are skipped
    // WITHOUT parsing — the restore fast-path discards them anyway
    // (records/index.ts snapshot branch), so the yielded stream is identical
    // while the dominant JSON.parse cost disappears.
    for (const entry of lines) {
      if (
        skipFoldedBeforeSnapshot &&
        entry.lineNumber < lastSnapshotLineNumber &&
        isSnapshotFoldedLine(entry.text)
      ) {
        continue;
      }
      const record = parseRecordLine(
        entry.text,
        entry.lineNumber,
        this.filePath,
        entry.allowTruncated,
      );
      if (record !== undefined) yield record;
    }
  }

  append(input: AgentRecord): void {
    this.throwIfError();
    this.pendingRecords.push(input);
    this.scheduleFlush();
  }

  rewrite(records: readonly AgentRecord[]): void {
    this.throwIfError();
    this.shouldClear = true;
    this.pendingRecords.splice(0, this.pendingRecords.length, ...records);
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    this.throwIfError();
    while (
      this.flushPromise !== undefined ||
      this.shouldClear ||
      this.pendingRecords.length > 0
    ) {
      await this.ensureFlush();
      this.throwIfError();
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private scheduleFlush(): void {
    void this.ensureFlush().catch((error) => {
      this.options.onError?.(error);
    });
  }

  private ensureFlush(): Promise<void> {
    if (this.flushPromise !== undefined) return this.flushPromise;

    const promise = this.drainPendingRecords()
      .catch((error: unknown) => {
        this.error = error;
        // oxlint-disable-next-line typescript-eslint/only-throw-error
        throw error;
      })
      .finally(() => {
        if (this.flushPromise === promise) {
          this.flushPromise = undefined;
        }
        if (
          this.error === undefined &&
          (this.shouldClear || this.pendingRecords.length > 0)
        ) {
          this.scheduleFlush();
        }
      });
    this.flushPromise = promise;
    return promise;
  }

  private throwIfError(): void {
    // oxlint-disable-next-line typescript-eslint/only-throw-error
    if (this.error !== undefined) throw this.error;
  }

  private async drainPendingRecords(): Promise<void> {
    while (this.shouldClear || this.pendingRecords.length > 0) {
      await this.drainBatch();
    }
  }

  private async drainBatch(): Promise<void> {
    const shouldClear = this.shouldClear;
    const batch = this.pendingRecords.splice(0);
    this.shouldClear = false;

    const writable = this.options.blobStore !== undefined
      ? await Promise.all(
          batch.map((record) => this.options.blobStore!.offload(record)),
        )
      : batch;

    const content = writable.map((e) => JSON.stringify(e) + '\n').join('');
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });

    const fh = await open(this.filePath, shouldClear ? 'w' : 'a');
    try {
      if (content.length > 0) {
        await fh.writeFile(content, 'utf8');
      }
      await fh.sync();
    } finally {
      await fh.close();
    }

    if (!this.directorySynced) {
      await syncDir(directory);
      this.directorySynced = true;
    }
  }
}

function parseRecordLine(
  line: string,
  lineNumber: number,
  filePath: string,
  allowTruncated: boolean,
): AgentRecord | undefined {
  if (line.length === 0) return undefined;
  try {
    return JSON.parse(line) as AgentRecord;
  } catch (parseError) {
    // Tolerate a truncated trailing line — last write may have crashed
    // mid-flush; everything before is still well-formed.
    if (allowTruncated) return undefined;
    throw new Error(
      `wire.jsonl: corrupted line ${lineNumber} in ${filePath}: ${String(parseError)}`,
      { cause: parseError },
    );
  }
}
