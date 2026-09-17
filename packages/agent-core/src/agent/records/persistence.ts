import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat } from 'node:fs/promises';
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

/**
 * Longest folded-type line prefix: the number of leading bytes a line needs
 * before the parse filter can decide whether to drop it. Until that many bytes
 * are seen the head is the only part of the line held in memory.
 */
const SNAPSHOT_FOLDED_MAX_PREFIX_BYTES = SNAPSHOT_FOLDED_LINE_PREFIX_BYTES.reduce(
  (longest, prefix) => Math.max(longest, prefix.length),
  0,
);

/** Bytes-level prefix test for a line head that may be shorter than the prefix. */
function headStartsWithPrefix(head: Buffer, headLength: number, prefix: Buffer): boolean {
  return headLength >= prefix.length && head.subarray(0, prefix.length).equals(prefix);
}

function headStartsWithAnyPrefix(
  head: Buffer,
  headLength: number,
  prefixes: readonly Buffer[],
): boolean {
  return prefixes.some((prefix) => headStartsWithPrefix(head, headLength, prefix));
}

/**
 * Whether folded context records that predate the last snapshot can be skipped
 * without decoding. Safe only when no wire migration is needed: a version
 * mismatch triggers migrations/rewrite that must see EVERY record, so
 * old/new-version files fall back to full parsing. The version lives in the
 * first (metadata) line. A header that cannot be parsed returns `false` here —
 * the same line is parsed again below, where the error is thrown.
 */
function readSkipFoldedFlag(headerText: string): boolean {
  try {
    const header = JSON.parse(headerText) as { protocol_version?: unknown };
    return header.protocol_version === AGENT_WIRE_PROTOCOL_VERSION;
  } catch {
    return false;
  }
}

/** File size in bytes, or `undefined` when the file does not exist yet. */
async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
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
    // Mirrors the file-backed reader: on a same-version wire, folded context
    // records that predate the last snapshot are not yielded — the snapshot
    // already carries their state and `replay()` applies everything it is
    // handed (records/index.ts). Without this filter an in-memory wire would
    // re-apply records the file path drops. Version mismatches skip nothing:
    // migration rewrites must see every record.
    const header = this.records[0];
    const skipFolded =
      header !== undefined &&
      header.type === 'metadata' &&
      header.protocol_version === AGENT_WIRE_PROTOCOL_VERSION;
    if (!skipFolded) {
      yield* this.records;
      return;
    }
    let lastSnapshotIndex = -1;
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i]?.type === 'context.snapshot') {
        lastSnapshotIndex = i;
        break;
      }
    }
    for (let i = 0; i < this.records.length; i++) {
      const record = this.records[i]!;
      if (i < lastSnapshotIndex && SNAPSHOT_FOLDED_CONTEXT_TYPES.has(record.type)) {
        continue;
      }
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

    // Resume used to buffer every line of the file before parsing any of them,
    // so peak memory was ~1x the file size plus every decoded record. On a
    // multi-gigabyte wire that aborted the process (V8 heap OOM) before the
    // first record was yielded. The file is now read twice with bounded memory
    // instead:
    //
    //   pass 1 (scanLastSnapshotLine) — byte-level scan that only counts lines
    //     and remembers the last `context.snapshot` line number. Nothing is
    //     decoded and no line is retained.
    //   pass 2 (streamRecords) — streaming decode in file order; lines the
    //     parse filter drops are never turned into JS strings at all.
    //
    // Both passes need the filter up front: whether a folded record may be
    // skipped depends on the LAST snapshot in the file, which is only knowable
    // after scanning everything.
    //
    // Line splitting recognizes ONLY "\n" (0x0A): record lines are JSON whose
    // text content may contain Unicode separators such as U+2028, which must
    // not break a record in half. Newline scanning runs on Buffers directly via
    // chunk.indexOf(0x0a) — every byte is examined exactly once, so splitting
    // stays linear in file size even when a multi-megabyte line spans hundreds
    // of stream chunks.
    // Both passes are bounded by the file size observed before the scan: the
    // previous implementation read the file to EOF once and then parsed that
    // fixed byte range, so records appended while a replay was in flight were
    // never replayed. A live stream would otherwise pick them up mid-iteration.
    const size = await fileSize(this.filePath);
    if (size === undefined || size === 0) return; // no wire yet

    const lastSnapshotLineNumber = await this.scanLastSnapshotLine(size);
    if (lastSnapshotLineNumber === undefined) return; // removed while reading

    yield* this.streamRecords(size, lastSnapshotLineNumber);
  }

  /**
   * Byte-level pass that returns the line number of the last
   * `context.snapshot` line, or `-1` when the file has none. `undefined` means
   * the file does not exist (a brand-new session has no wire yet — not an
   * error). Nothing is decoded and no line is retained: memory stays at one
   * stream chunk.
   */
  private async scanLastSnapshotLine(size: number): Promise<number | undefined> {
    const prefix = SNAPSHOT_RECORD_LINE_PREFIX_BYTES;
    const head = Buffer.allocUnsafe(prefix.length);
    let headLength = 0;
    let lineNumber = 0;
    let lastSnapshotLineNumber = -1;
    const stream = createReadStream(this.filePath, { end: size - 1 });
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        let searchFrom = 0;
        for (;;) {
          const newlineIndex = chunk.indexOf(0x0a, searchFrom);
          const end = newlineIndex === -1 ? chunk.length : newlineIndex;
          if (end > searchFrom && headLength < prefix.length) {
            const take = Math.min(prefix.length - headLength, end - searchFrom);
            chunk.copy(head, headLength, searchFrom, searchFrom + take);
            headLength += take;
          }
          if (newlineIndex === -1) break;
          lineNumber++;
          if (headLength === prefix.length && head.equals(prefix)) {
            lastSnapshotLineNumber = lineNumber;
          }
          headLength = 0;
          searchFrom = newlineIndex + 1;
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      throw error;
    }
    return lastSnapshotLineNumber;
  }

  /**
   * Streaming replay pass. Folded records predating the last snapshot are
   * dropped WITHOUT being decoded — the restore fast-path discards them anyway
   * (records/index.ts snapshot branch), so the yielded stream is identical to a
   * full decode while neither the file nor the skipped lines are ever held in
   * memory. An unterminated trailing line is tolerated (see parseRecordLine):
   * the last write may have crashed mid-flush.
   */
  private async *streamRecords(
    size: number,
    lastSnapshotLineNumber: number,
  ): AsyncIterable<AgentRecord> {
    const head = Buffer.allocUnsafe(SNAPSHOT_FOLDED_MAX_PREFIX_BYTES);
    let headLength = 0;
    // Buffers accumulated for the currently open line, in file order.
    let openChunks: Buffer[] = [];
    let decided = false;
    let retaining = false;
    let headerSeen = false;
    let skipFoldedBeforeSnapshot = false;
    let lineNumber = 0;

    // `head` is a single buffer reused for every line, so a retained line is
    // always a copy of the head bytes followed by chunk views.
    const retainedLine = (): Buffer =>
      openChunks.length === 1 ? openChunks[0]! : Buffer.concat(openChunks);

    const keepLine = (currentLine: number): boolean =>
      !(
        skipFoldedBeforeSnapshot &&
        currentLine < lastSnapshotLineNumber &&
        headStartsWithAnyPrefix(head, headLength, SNAPSHOT_FOLDED_LINE_PREFIX_BYTES)
      );

    const stream = createReadStream(this.filePath, { end: size - 1 });
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        let searchFrom = 0;
        for (;;) {
          const newlineIndex = chunk.indexOf(0x0a, searchFrom);
          const end = newlineIndex === -1 ? chunk.length : newlineIndex;
          if (!decided && end > searchFrom) {
            const take = Math.min(SNAPSHOT_FOLDED_MAX_PREFIX_BYTES - headLength, end - searchFrom);
            chunk.copy(head, headLength, searchFrom, searchFrom + take);
            headLength += take;
            searchFrom += take;
            if (headLength === SNAPSHOT_FOLDED_MAX_PREFIX_BYTES) {
              decided = true;
              retaining = keepLine(lineNumber + 1);
              if (retaining) openChunks.push(Buffer.from(head));
            }
          }
          if (retaining && end > searchFrom) {
            openChunks.push(chunk.subarray(searchFrom, end));
          }
          if (newlineIndex === -1) break;

          lineNumber++;
          if (!decided) {
            // The line ended before the longest fold prefix was complete, so it
            // cannot match any of them.
            decided = true;
            retaining = keepLine(lineNumber);
            if (retaining && headLength > 0) {
              openChunks.push(Buffer.from(head.subarray(0, headLength)));
            }
          }
          if (retaining) {
            let lineData = retainedLine();
            // Tolerate a bare "\r" before the newline (CRLF files).
            if (lineData.length > 0 && lineData.at(-1) === 0x0d) {
              lineData = lineData.subarray(0, lineData.length - 1);
            }
            const lineText = lineData.toString('utf8');
            if (!headerSeen) {
              headerSeen = true;
              skipFoldedBeforeSnapshot = readSkipFoldedFlag(lineText);
            }
            const record = parseRecordLine(lineText, lineNumber, this.filePath, false);
            if (record !== undefined) yield record;
          }
          openChunks = [];
          headLength = 0;
          decided = false;
          retaining = false;
          searchFrom = newlineIndex + 1;
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw error;
    }
    // A non-empty open line means the file's last newline was followed by more
    // bytes — an unterminated trailing line whose JSON may be torn.
    if (!decided && headLength > 0) {
      decided = true;
      retaining = keepLine(lineNumber + 1);
      if (retaining) openChunks.push(Buffer.from(head.subarray(0, headLength)));
    }
    if (retaining && openChunks.length > 0) {
      lineNumber++;
      let lineData = retainedLine();
      if (lineData.length > 0 && lineData.at(-1) === 0x0d) {
        lineData = lineData.subarray(0, lineData.length - 1);
      }
      const record = parseRecordLine(lineData.toString('utf8'), lineNumber, this.filePath, true);
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
