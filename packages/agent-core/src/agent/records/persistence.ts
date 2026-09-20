import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'pathe';

import { syncDir } from '../../utils/fs';
import type { BlobStore } from './blobref';
import { AGENT_WIRE_PROTOCOL_VERSION } from './migration';
import { type AgentRecord, type AgentRecordPersistence } from './types';

/**
 * Record types whose state is fully captured by — or has become unobservable
 * behind — a `context.snapshot` record, so a copy of them that predates the
 * last snapshot can be dropped without changing what a resume restores.
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
  // Request headers are pure diagnostics: restore never consumes them and the
  // replay window never surfaces them. They are also the largest per-request
  // record (a full system prompt per request), so folding them — and thus
  // letting resume-time compaction reclaim them physically — is what keeps a
  // long-lived wire bounded on disk.
  'request.header',
  // NOTE: 'context.stream_draft' is deliberately NOT folded here. Folding a
  // type drops every line of it that predates the last snapshot, but a turn's
  // LAST draft can legitimately predate the last snapshot while still being the
  // "incomplete reply" the replay window exists to surface (an aborted stream
  // whose draft was never cleared, followed by a compaction). Dropping it would
  // silently change what resume shows. Drafts are reclaimed by the dedicated
  // per-turnId retention rule instead (keepLine / read() below), which keeps
  // that last draft and drops only the intermediate ones — those are provably
  // unobservable because restore replaces a turn's draft in place.
  // Measurements (this repo's own wires): per-turn retention reclaims ~99.99%
  // of the draft bytes; folding the whole type on top of it reclaims a further
  // ~2 KB total, at the cost of the partial marker above.
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

/**
 * Every `context.stream_draft` line starts with this byte-exact prefix; the
 * turnId value follows immediately. Drafts are throttled UI state (several per
 * turn), so compaction keeps only the LAST draft per turnId — the earlier ones
 * are overwritten in place by `replayBuilder.replacePartialDraft()` on resume
 * and are therefore unobservable.
 */
const DRAFT_LINE_PREFIX = '{"type":"context.stream_draft","turnId":"';
const DRAFT_LINE_PREFIX_BYTES = Buffer.from(DRAFT_LINE_PREFIX, 'utf8');
/** TurnIds are generated ids (≤36 chars); scan a bounded window past the prefix. */
const DRAFT_TURNID_MAX_CHARS = 72;
/** Head bytes needed to classify a draft line (prefix + turnId + closing quote). */
const DRAFT_HEAD_SCAN_BYTES = DRAFT_LINE_PREFIX_BYTES.length + DRAFT_TURNID_MAX_CHARS;
/** Head buffer size for both streaming passes: classify folds AND draft turnIds. */
const WIRE_HEAD_BYTES = Math.max(SNAPSHOT_FOLDED_MAX_PREFIX_BYTES, DRAFT_HEAD_SCAN_BYTES);

/**
 * Extract the turnId from a `context.stream_draft` line head.
 *
 * - `undefined`: the head does not start with the draft prefix (not a draft).
 * - `null`: it IS a draft but the turnId cannot be classified within the
 *   bounded head (empty id, escape sequence, or over-long id) — the line is
 *   kept: never drop a line whose identity is uncertain.
 * - a string: the turnId.
 */
function draftTurnIdFromHead(head: Buffer, headLength: number): string | null | undefined {
  if (!headStartsWithPrefix(head, headLength, DRAFT_LINE_PREFIX_BYTES)) return undefined;
  const from = DRAFT_LINE_PREFIX_BYTES.length;
  for (let i = from; i < headLength; i++) {
    const byte = head[i];
    if (byte === 0x22) {
      // Closing quote of the turnId value.
      if (i === from) return null;
      const raw = head.toString('utf8', from, i);
      // Escaped quotes/backslashes would make the naive scan unreliable.
      return raw.includes('\\') ? null : raw;
    }
  }
  // Head exhausted without the closing quote: only possible while the line is
  // still streaming (more bytes coming), or the id overflows the scan window.
  return headLength >= WIRE_HEAD_BYTES ? null : undefined;
}

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
  /** Folded-history watermark for shouldCompactOnResume(); defaults to WIRE_COMPACT_SKIPPED_BYTES. */
  readonly compactThresholdBytes?: number | undefined;
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
    // Mirror the file-backed reader's draft retention: only the LAST draft per
    // turnId survives (restore replaces drafts per turnId in place, so earlier
    // drafts are unobservable) — regardless of whether the wire has a snapshot.
    const draftLastIndex = new Map<string, number>();
    for (let i = 0; i < this.records.length; i++) {
      const record = this.records[i]!;
      if (record.type === 'context.stream_draft') draftLastIndex.set(record.turnId, i);
    }
    for (let i = 0; i < this.records.length; i++) {
      const record = this.records[i]!;
      if (
        record.type === 'context.stream_draft' &&
        draftLastIndex.get(record.turnId) !== i
      ) {
        continue;
      }
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
  /** Set while `compact()` runs; writes queue up instead of draining. */
  private compacting = false;
  /** Folded-history bytes skipped by the most recent full read(). */
  private droppedBytes = 0;
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
    const draftLastLines = await this.scanDraftLastLines(size);
    if (draftLastLines === undefined) return; // removed while reading

    yield* this.streamRecords(size, lastSnapshotLineNumber, draftLastLines);
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
   * Byte-level pass that maps every stream-draft turnId to the line number of
   * its LAST draft. Together with the fold set this lets both read() and
   * compact() reclaim a turn's earlier drafts: restore replaces drafts per
   * turnId in place (ReplayBuilder.replacePartialDraft), so intermediate drafts
   * are unobservable. Returns `undefined` when the file does not exist.
   */
  private async scanDraftLastLines(size: number): Promise<Map<string, number> | undefined> {
    const head = Buffer.allocUnsafe(DRAFT_HEAD_SCAN_BYTES);
    let headLength = 0;
    let lineNumber = 0;
    // Bytes of the line currently being scanned (views, no copy). Reset at each
    // newline, so at most one line is ever held: that is what lets us validate
    // the unterminated tail below without buffering the whole file.
    let openLine: Buffer[] = [];
    const lastLines = new Map<string, number>();
    const stream = createReadStream(this.filePath, { end: size - 1 });
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        let searchFrom = 0;
        for (;;) {
          const newlineIndex = chunk.indexOf(0x0a, searchFrom);
          const end = newlineIndex === -1 ? chunk.length : newlineIndex;
          if (headLength < head.length && end > searchFrom) {
            const take = Math.min(head.length - headLength, end - searchFrom);
            chunk.copy(head, headLength, searchFrom, searchFrom + take);
            headLength += take;
          }
          if (end > searchFrom) openLine.push(chunk.subarray(searchFrom, end));
          if (newlineIndex === -1) break;
          lineNumber++;
          const turnId = draftTurnIdFromHead(head, headLength);
          if (typeof turnId === 'string') lastLines.set(turnId, lineNumber);
          headLength = 0;
          openLine = [];
          searchFrom = newlineIndex + 1;
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      throw error;
    }
    // An unterminated trailing line (no final newline) is classified by
    // streamRecords()/copyRetainingLines() as line `lineNumber + 1`, so it has to
    // be considered here too — otherwise a wire whose last line is a draft would
    // treat the PREVIOUS draft of that turn as the last one. But the tail may be
    // a torn write (crash mid-flush): registering a torn line would shadow the
    // last COMPLETE draft of that turn and drop it, losing exactly the state
    // this rule exists to keep. So only a tail that parses as a draft counts.
    if (openLine.length > 0) {
      const tail = Buffer.concat(openLine).toString('utf8');
      try {
        const parsed = JSON.parse(tail) as { type?: unknown; turnId?: unknown };
        if (parsed.type === 'context.stream_draft' && typeof parsed.turnId === 'string') {
          lastLines.set(parsed.turnId, lineNumber + 1);
        }
      } catch {
        // Torn tail: leave it unregistered. The earlier complete draft of that
        // turn becomes the "last" one and survives; the torn bytes yield no
        // record either way (parseRecordLine returns undefined for them).
      }
    }
    return lastLines;
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
    draftLastLines: ReadonlyMap<string, number>,
  ): AsyncIterable<AgentRecord> {
    const head = Buffer.allocUnsafe(WIRE_HEAD_BYTES);
    let headLength = 0;
    // Buffers accumulated for the currently open line, in file order.
    let openChunks: Buffer[] = [];
    let decided = false;
    let retaining = false;
    let headerSeen = false;
    let skipFoldedBeforeSnapshot = false;
    let lineNumber = 0;
    let lineBytes = 0;
    let skippedBytes = 0;

    // `head` is a single buffer reused for every line, so a retained line is
    // always a copy of the head bytes followed by chunk views.
    const retainedLine = (): Buffer =>
      openChunks.length === 1 ? openChunks[0]! : Buffer.concat(openChunks);

    const keepLine = (currentLine: number): boolean => {
      // Earlier drafts of a turn are unobservable on resume: restore replaces
      // drafts per turnId in place (ReplayBuilder.replacePartialDraft), so only
      // the LAST draft per turnId matters. This applies regardless of whether
      // the wire has a snapshot — snapshot-less wires are the dominant shape.
      // A draft whose turnId cannot be classified (null) is always kept.
      // Nothing is skipped until the header has confirmed a same-version wire:
      // migration must see every record, including drafts. This also keeps the
      // file path aligned with InMemoryAgentRecordPersistence.read(), which
      // yields the raw records verbatim on a version mismatch.
      if (!skipFoldedBeforeSnapshot) return true;
      if (headStartsWithPrefix(head, headLength, DRAFT_LINE_PREFIX_BYTES)) {
        const turnId = draftTurnIdFromHead(head, headLength);
        if (turnId !== null && turnId !== undefined && draftLastLines.get(turnId) !== currentLine) {
          return false;
        }
      }
      if (
        currentLine < lastSnapshotLineNumber &&
        headStartsWithAnyPrefix(head, headLength, SNAPSHOT_FOLDED_LINE_PREFIX_BYTES)
      ) {
        return false;
      }
      return true;
    };

    const stream = createReadStream(this.filePath, { end: size - 1 });
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        let searchFrom = 0;
        for (;;) {
          const newlineIndex = chunk.indexOf(0x0a, searchFrom);
          const end = newlineIndex === -1 ? chunk.length : newlineIndex;
          if (!decided && end > searchFrom) {
            const take = Math.min(WIRE_HEAD_BYTES - headLength, end - searchFrom);
            chunk.copy(head, headLength, searchFrom, searchFrom + take);
            headLength += take;
            searchFrom += take;
            lineBytes += take;
            if (headLength === WIRE_HEAD_BYTES) {
              decided = true;
              retaining = keepLine(lineNumber + 1);
              if (retaining) openChunks.push(Buffer.from(head));
            }
          }
          if (retaining && end > searchFrom) {
            openChunks.push(chunk.subarray(searchFrom, end));
          }
          if (newlineIndex === -1) {
            lineBytes += end - searchFrom;
            break;
          }

          lineBytes += newlineIndex + 1 - searchFrom;
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
          if (!retaining) skippedBytes += lineBytes;
          openChunks = [];
          headLength = 0;
          decided = false;
          retaining = false;
          lineBytes = 0;
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
    } else if (!retaining) {
      skippedBytes += lineBytes;
    }
    // Exposed via droppedBytesOnLastRead() so the resume path can decide
    // whether the folded history is worth physically reclaiming.
    this.droppedBytes = skippedBytes;
  }

  /** Folded-history bytes skipped by the most recent full read(). */
  droppedBytesOnLastRead(): number {
    return this.droppedBytes;
  }

  /** Whether the last read() skipped enough folded history to be worth reclaiming on disk. */
  shouldCompactOnResume(): boolean {
    return this.droppedBytes >= (this.options.compactThresholdBytes ?? WIRE_COMPACT_SKIPPED_BYTES);
  }

  /**
   * Physically drop every record that predates the last `context.snapshot`
   * (exactly the lines `read()` skips). Byte-preserving: retained lines are
   * copied verbatim, so unknown records, CRLF framing and blob references
   * survive untouched. Writes a temp file, fsyncs it, then atomically renames
   * it over the wire. While it runs, appends queue up instead of draining
   * (see compacting) and are flushed right after the swap.
   */
  async compact(): Promise<void> {
    await this.flush();
    this.compacting = true;
    const tmpPath = `${this.filePath}.${process.pid}.${this.rewriteSeq++}.compact.tmp`;
    let swapped = false;
    try {
      const size = await fileSize(this.filePath);
      if (size === undefined || size === 0) return;
      const lastSnapshotLineNumber = await this.scanLastSnapshotLine(size);
      if (lastSnapshotLineNumber === undefined) return;
      const draftLastLines = await this.scanDraftLastLines(size);
      if (draftLastLines === undefined) return;
      const directory = dirname(this.filePath);
      const tmp = await open(tmpPath, 'w');
      let written = 0;
      try {
        written = await copyRetainingLines(
          this.filePath,
          tmp,
          size,
          lastSnapshotLineNumber,
          draftLastLines,
        );
        await tmp.sync();
      } finally {
        await tmp.close();
      }
      if (written === size) {
        // Nothing was folded: skip the swap (and remove the temp file).
        this.droppedBytes = 0;
        return;
      }
      const sizeNow = await fileSize(this.filePath);
      if (sizeNow !== size) {
        // The wire changed while we were copying (a concurrent writer). Keep
        // the original file and drop the temp copy rather than lose bytes.
        return;
      }
      await rename(tmpPath, this.filePath);
      swapped = true;
      await syncDir(directory);
      this.directorySynced = true;
      this.droppedBytes = 0;
    } finally {
      if (!swapped) await rm(tmpPath, { force: true }).catch(() => {});
      this.compacting = false;
      if (this.shouldClear || this.pendingRecords.length > 0) this.scheduleFlush();
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
    // A compaction swap in flight makes writes queue up (see compact());
    // flush() is the durability barrier, so wait it out instead of returning
    // while records are still pending.
    while (this.compacting) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
    // While compacting, new appends queue up in pendingRecords instead of
    // draining: a batch opened against the pre-rename file would write to the
    // inode that is about to be replaced. compact() re-schedules the flush
    // once the swap is done.
    if (this.compacting) return Promise.resolve();
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
    // Belt-and-braces against the compaction swap: batches opened while the
    // temp file is being renamed must not target the pre-swap inode.
    while (!this.compacting && (this.shouldClear || this.pendingRecords.length > 0)) {
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
        await writeChunked(tmp, writable);
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
      await writeChunked(fh, writable);
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

/**
 * Serialize records to wire lines and write them in bounded chunks. Joining
 * an entire batch into one string spikes memory to the full batch size (a
 * single burst can be many megabytes); chunked writes on the same handle
 * keep peak allocation at `MAX_WRITE_CHUNK_CHARS` while preserving the
 * durability contract exactly — one fsync per batch, ordered lines.
 */
/** Same-version resume compacts the wire once this much folded history accumulated on disk. */
export const WIRE_COMPACT_SKIPPED_BYTES = 8 * 1024 * 1024;

const MAX_WRITE_CHUNK_CHARS = 1_000_000;

/**
 * Byte-preserving filter pass for compact(): copies every line that
 * streamRecords() would retain (same fold decision, same per-turn draft
 * retention, same unterminated-tail tolerance) into `out`, returning the
 * number of bytes written. Kept in the same shape as streamRecords() on
 * purpose — the two must agree on which lines survive; change both together.
 */
async function copyRetainingLines(
  filePath: string,
  out: FileHandle,
  size: number,
  lastSnapshotLineNumber: number,
  draftLastLines: ReadonlyMap<string, number>,
): Promise<number> {
  const head = Buffer.allocUnsafe(WIRE_HEAD_BYTES);
  let headLength = 0;
  let openChunks: Buffer[] = [];
  let decided = false;
  let retaining = false;
  let headerSeen = false;
  let skipFoldedBeforeSnapshot = false;
  let lineNumber = 0;
  let written = 0;

  const keepLine = (currentLine: number): boolean => {
    // Must mirror streamRecords(): nothing is skipped before the header has
    // confirmed a same-version wire (migration sees every record), and beyond
    // that only the last draft per turnId survives — earlier drafts of a turn
    // are unobservable on resume (restore replaces drafts per turnId in place).
    // Unclassifiable drafts (null) are kept.
    if (!skipFoldedBeforeSnapshot) return true;
    if (headStartsWithPrefix(head, headLength, DRAFT_LINE_PREFIX_BYTES)) {
      const turnId = draftTurnIdFromHead(head, headLength);
      if (turnId !== null && turnId !== undefined && draftLastLines.get(turnId) !== currentLine) {
        return false;
      }
    }
    if (
      currentLine < lastSnapshotLineNumber &&
      headStartsWithAnyPrefix(head, headLength, SNAPSHOT_FOLDED_LINE_PREFIX_BYTES)
    ) {
      return false;
    }
    return true;
  };

  const writeRetainedLine = async (): Promise<void> => {
    const data = openChunks.length === 1 ? openChunks[0]! : Buffer.concat(openChunks);
    if (data.length > 0) {
      await out.write(data);
      written += data.length;
    }
  };

  const stream = createReadStream(filePath, { end: size - 1 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let searchFrom = 0;
    for (;;) {
      const newlineIndex = chunk.indexOf(0x0a, searchFrom);
      const end = newlineIndex === -1 ? chunk.length : newlineIndex;
      if (!decided && end > searchFrom) {
        const take = Math.min(WIRE_HEAD_BYTES - headLength, end - searchFrom);
        chunk.copy(head, headLength, searchFrom, searchFrom + take);
        headLength += take;
        searchFrom += take;
        if (headLength === WIRE_HEAD_BYTES) {
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
        decided = true;
        retaining = keepLine(lineNumber);
        if (retaining && headLength > 0) openChunks.push(Buffer.from(head.subarray(0, headLength)));
      }
      if (retaining) {
        openChunks.push(chunk.subarray(newlineIndex, newlineIndex + 1));
        if (!headerSeen) {
          headerSeen = true;
          let lineData = openChunks.length === 1 ? openChunks[0]! : Buffer.concat(openChunks);
          if (lineData.length > 0 && lineData.at(-1) === 0x0a) {
            lineData = lineData.subarray(0, lineData.length - 1);
          }
          if (lineData.length > 0 && lineData.at(-1) === 0x0d) {
            lineData = lineData.subarray(0, lineData.length - 1);
          }
          skipFoldedBeforeSnapshot = readSkipFoldedFlag(lineData.toString('utf8'));
        }
        await writeRetainedLine();
      }
      openChunks = [];
      headLength = 0;
      decided = false;
      retaining = false;
      searchFrom = newlineIndex + 1;
    }
  }
  // Unterminated trailing line (a crashed mid-flush write is tolerated by
  // read(); keep it byte-for-byte here as well).
  if (!decided && headLength > 0) {
    decided = true;
    retaining = keepLine(lineNumber + 1);
    if (retaining) openChunks.push(Buffer.from(head.subarray(0, headLength)));
  }
  if (retaining && openChunks.length > 0) {
    await writeRetainedLine();
  }
  return written;
}

async function writeChunked(
  handle: FileHandle,
  records: readonly AgentRecord[],
): Promise<void> {
  let chunk = '';
  for (const record of records) {
    chunk += JSON.stringify(record) + '\n';
    if (chunk.length >= MAX_WRITE_CHUNK_CHARS) {
      await handle.write(chunk, null, 'utf8');
      chunk = '';
    }
  }
  if (chunk.length > 0) {
    await handle.write(chunk, null, 'utf8');
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
