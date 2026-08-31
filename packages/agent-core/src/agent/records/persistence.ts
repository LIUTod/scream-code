import { createReadStream } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
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
 *
 * Probes run on raw UTF-8 bytes (see SNAPSHOT_RECORD_LINE_PREFIX_BYTES): all
 * characters in these prefixes are ASCII, so byte-level matching is exact.
 */
const SNAPSHOT_RECORD_LINE_PREFIX = '{"type":"context.snapshot"';

/** Line prefixes of the folded record types, derived from the set above. */
const SNAPSHOT_FOLDED_LINE_PREFIXES: readonly string[] = [...SNAPSHOT_FOLDED_CONTEXT_TYPES].map(
  (type) => `{"type":"${type}"`,
);

/** UTF-8 bytes of {@link SNAPSHOT_RECORD_LINE_PREFIX}. */
const SNAPSHOT_RECORD_LINE_PREFIX_BYTES = Buffer.from(SNAPSHOT_RECORD_LINE_PREFIX, 'utf8');

/** UTF-8 bytes of each entry of {@link SNAPSHOT_FOLDED_LINE_PREFIXES}. */
const SNAPSHOT_FOLDED_LINE_PREFIX_BYTES: readonly Buffer[] = SNAPSHOT_FOLDED_LINE_PREFIXES.map(
  (prefix) => Buffer.from(prefix, 'utf8'),
);

function startsWithPrefix(data: Buffer, prefix: Buffer): boolean {
  return data.length >= prefix.length && data.subarray(0, prefix.length).equals(prefix);
}

function startsWithAnyPrefix(data: Buffer, prefixes: readonly Buffer[]): boolean {
  return prefixes.some((prefix) => startsWithPrefix(data, prefix));
}

/** A buffered physical line from the wire file. */
interface WireLine {
  /**
   * Raw UTF-8 bytes of the line WITHOUT its terminating newline. Lines are
   * held as bytes rather than decoded strings so that lines skipped by the
   * parse filter never pay decode cost or JS-string memory (~2x the byte
   * size); only surviving lines are decoded exactly once in phase 2.
   */
  readonly data: Buffer;
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
  private rewriteSeq = 0;
  private flushPromise: Promise<void> | undefined;
  private error: unknown;

  constructor(
    private readonly filePath: string,
    private readonly options: FileSystemAgentRecordPersistenceOptions = {},
  ) {}

  async *read(): AsyncIterable<AgentRecord> {
    await this.flush();

    // Phase 1: buffer raw lines WITHOUT parsing, tracking the last
    // context.snapshot line via the cheap byte-prefix probe. On long sessions
    // the file can reach hundreds of MB; holding each line as raw UTF-8 bytes
    // (instead of decoded JS strings, which cost ~2x memory) keeps GC pressure
    // during collection near zero. Only lines that survive the phase-2 skip
    // filter are decoded.
    //
    // Line splitting recognizes ONLY "\n" (0x0A): record lines are JSON whose
    // text content may contain Unicode separators such as U+2028, which must
    // not break a record in half. Newline scanning runs on Buffers directly
    // via chunk.indexOf(0x0a) — every byte is examined exactly once (each
    // chunk is scanned on arrival and leftovers are accumulated per open
    // line), so splitting stays linear even when a multi-megabyte snapshot
    // line spans hundreds of stream chunks.
    const lines: WireLine[] = [];
    let lastSnapshotLineNumber = -1;
    let lineNumber = 0;
    // Buffers accumulated for the currently open (unterminated) line.
    let openChunks: Buffer[] = [];
    const stream = createReadStream(this.filePath);
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        // Each incoming chunk is scanned exactly once (Buffer.indexOf is
        // byte-level), so splitting is linear in file size even when a
        // multi-megabyte snapshot line spans hundreds of chunks.
        let searchFrom = 0;
        for (;;) {
          const newlineIndex = chunk.indexOf(0x0a, searchFrom);
          if (newlineIndex === -1) break;
          const parts =
            openChunks.length > 0
              ? [...openChunks, chunk.subarray(searchFrom, newlineIndex)]
              : [chunk.subarray(searchFrom, newlineIndex)];
          let lineData = Buffer.concat(parts);
          // Tolerate a bare "\r" before the newline (CRLF files).
          if (lineData.length > 0 && lineData.at(-1) === 0x0d) {
            lineData = lineData.subarray(0, lineData.length - 1);
          }
          lineNumber++;
          if (startsWithPrefix(lineData, SNAPSHOT_RECORD_LINE_PREFIX_BYTES)) {
            lastSnapshotLineNumber = lineNumber;
          }
          lines.push({ data: lineData, lineNumber, allowTruncated: false });
          openChunks = [];
          searchFrom = newlineIndex + 1;
        }
        if (searchFrom < chunk.length) {
          openChunks.push(chunk.subarray(searchFrom));
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw error;
    }
    // openChunks is only appended to when at least one unconsumed byte
    // remains, so a non-empty list means the file's last newline was followed
    // by more bytes — an unterminated trailing line.
    if (openChunks.length > 0) {
      lineNumber++;
      // Unterminated trailing line — the last write may have crashed
      // mid-flush; parsing it tolerates truncation (see parseRecordLine).
      lines.push({
        data: Buffer.concat(openChunks),
        lineNumber,
        allowTruncated: true,
      });
    }

    // Parse-skipping is only safe when no wire migration is needed: a version
    // mismatch triggers migrations/rewrite that must see EVERY record, so
    // old/new-version files fall back to full parsing. The version lives in
    // the first (metadata) line.
    let skipFoldedBeforeSnapshot = false;
    if (lines.length > 0) {
      try {
        const header = JSON.parse(lines[0]!.data.toString('utf8')) as {
          protocol_version?: unknown;
        };
        skipFoldedBeforeSnapshot = header.protocol_version === AGENT_WIRE_PROTOCOL_VERSION;
      } catch {
        skipFoldedBeforeSnapshot = false; // header error re-thrown in phase 2
      }
    }

    // Phase 2: parse. Folded records predating the last snapshot are skipped
    // WITHOUT parsing or decoding — the restore fast-path discards them anyway
    // (records/index.ts snapshot branch), so the yielded stream is identical
    // while the dominant JSON.parse cost disappears.
    for (const entry of lines) {
      if (
        skipFoldedBeforeSnapshot &&
        entry.lineNumber < lastSnapshotLineNumber &&
        startsWithAnyPrefix(entry.data, SNAPSHOT_FOLDED_LINE_PREFIX_BYTES)
      ) {
        continue;
      }
      const record = parseRecordLine(
        entry.data.toString('utf8'),
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

    if (shouldClear) {
      // Rewrite atomically. Opening the live path with 'w' truncates it
      // before the replacement bytes land, so a crash mid-rewrite destroys
      // the entire wire file (the only copy of session history). A temp
      // file + rename keeps the old content until the new one is complete
      // and makes the swap atomic on POSIX.
      const tmpPath = `${this.filePath}.${process.pid}.${this.rewriteSeq++}.tmp`;
      const tmp = await open(tmpPath, 'w');
      try {
        if (content.length > 0) {
          await tmp.writeFile(content, 'utf8');
        }
        await tmp.sync();
      } finally {
        await tmp.close();
      }
      await rename(tmpPath, this.filePath);
      await syncDir(directory);
      this.directorySynced = true;
      return;
    }

    const fh = await open(this.filePath, 'a');
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
