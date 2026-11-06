import type {
  ExecutableToolErrorResult,
  ExecutableToolSuccessResult,
} from '../../loop/types';

// Budgets are bytes, not code units. A UTF-16 code unit is not a cost: a CJK
// character is 3 UTF-8 bytes and an emoji is 4, so a "50k character" budget
// quietly became 150 KB for Chinese output. Line granularity is the other half:
// the head only ever holds whole lines, so a cut can never split a UTF-8
// sequence — the failure mode that produced lone surrogates in tool output.
const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_TAIL_BYTES = 20 * 1024;
const DEFAULT_MAX_LINE_BYTES = 2048;
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_FULL_OUTPUT_BYTES = 1_000_000;
const TRUNCATION_MARKER = '[...truncated]';
const TRUNCATION_MESSAGE = 'Output is truncated to fit in the message.';

/**
 * Optional sink that persists the full, untruncated tool output so the model
 * can recover what head/tail truncation elided. Receives the complete output
 * and returns a reference (e.g. a file path or artifact id) that is appended
 * to the truncated output. Returning `undefined` (or throwing) leaves the
 * output without an artifact reference.
 */
export type ArtifactSink = (fullOutput: string) => Promise<string | undefined>;

export interface ToolResultBuilderOptions {
  /** Bytes retained for the head before the tail window takes over. */
  readonly maxBytes?: number;
  /** Bytes retained for the tail window. */
  readonly maxTailBytes?: number;
  /** Per-line byte cap; `null` disables it (JSON streams, single-line output). */
  readonly maxLineBytes?: number | null;
  /** Whole lines retained in the head before truncation starts. */
  readonly maxLines?: number;
  /**
   * When provided, the builder retains the full output in memory and offloads
   * it through this sink on truncation, appending the returned reference so the
   * elided middle becomes recoverable. Omit to keep the streaming/forget memory
   * profile and skip artifact offloading.
   */
  readonly artifactSink?: ArtifactSink;
  /** Bytes of full output to retain in memory for artifact offloading. */
  readonly maxFullOutputBytes?: number;
}

export type ExecutableToolResultBuilderResult = (
  | ExecutableToolSuccessResult
  | ExecutableToolErrorResult
) & {
  readonly output: string;
  // Optional: the brief is only present when it is NOT already folded into
  // the output (see message handling in `ok`/`error`).
  readonly message?: string | undefined;
  readonly truncated: boolean;
  readonly brief?: string;
};

export class ToolResultBuilder {
  private readonly maxBytes: number;
  private readonly maxTailBytes: number;
  private readonly maxLineBytes: number | null;
  private readonly maxLines: number;
  private readonly artifactSink?: ArtifactSink;
  private readonly maxFullOutputBytes: number;

  private readonly buffer: string[] = [];
  private nBytesValue = 0;
  private nCharsValue = 0;
  private linesInHead = 0;
  private truncationHappened = false;
  private headTruncated = false;

  private readonly tailBuf: string[] = [];
  private tailBytesValue = 0;
  private tailCharsValue = 0;

  // Full-output retention is only enabled when an artifactSink is configured,
  // so the default streaming/forget memory profile is unchanged. totalLinesWritten
  // feeds the "N lines elided" counter shown on head+tail truncation.
  private readonly fullOutput?: string[];
  private fullOutputBytes = 0;
  private totalLinesWritten = 0;

  constructor(options: ToolResultBuilderOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxTailBytes = options.maxTailBytes ?? DEFAULT_TAIL_BYTES;
    this.maxLineBytes =
      options.maxLineBytes === undefined ? DEFAULT_MAX_LINE_BYTES : options.maxLineBytes;
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;

    if (this.maxLineBytes !== null && this.maxLineBytes <= byteLength(TRUNCATION_MARKER)) {
      throw new Error('maxLineBytes must be greater than the truncation marker length.');
    }
    this.artifactSink = options.artifactSink;
    this.maxFullOutputBytes = options.maxFullOutputBytes ?? DEFAULT_MAX_FULL_OUTPUT_BYTES;
    if (this.artifactSink !== undefined) {
      this.fullOutput = [];
    }
  }

  /** Characters retained so far (UI/logging); the budget itself is bytes. */
  get nChars(): number {
    return this.nCharsValue + this.tailCharsValue;
  }

  /** Bytes retained so far. */
  get nBytes(): number {
    return this.nBytesValue + this.tailBytesValue;
  }

  toString(): string {
    const buffered = this.buffer.join('');
    if (!this.headTruncated || this.tailBytesValue === 0) {
      return buffered;
    }
    this.trimTail();
    const tail = this.tailBuf.join('');
    // The head budget and the tail budget are separate while writing, so a
    // truncation would otherwise deliver head + tail + marker — more than the
    // caller asked for. Carry the marker and the tail against the same budget,
    // and do it before counting: the elided count has to describe what is
    // actually printed, not what was buffered. (A codepoint-safe cut is fine
    // here: the marker already announces the cut.)
    const markerBytes = 128;
    const headBudget = this.maxBytes - markerBytes - this.tailBytesValue;
    const head =
      headBudget >= 0 && byteLength(buffered) > headBudget
        ? truncateToBytes(buffered, headBudget)
        : buffered;
    const elided = this.computeElidedLines(head, tail);
    // Where the head was cut mid-line (no trailing newline) the marker sits
    // inline, which keeps it attached to the text it replaced. When the head
    // ended on a line boundary the marker gets its own line, so it cannot be
    // glued onto the first tail line and read as part of it.
    const marker =
      elided > 0 ? `[…${String(elided)} lines elided…]\n${TRUNCATION_MARKER}` : TRUNCATION_MARKER;
    const markerBlock = head.endsWith('\n') ? `${marker}\n` : marker;
    return `${head}${markerBlock}${tail}`;
  }

  write(text: string): number {
    if (text.length === 0) return 0;

    const lines = text.match(/[^\r\n]*(?:\r\n|[\n\r])|[^\r\n]+/g) ?? [];
    if (lines.length === 0) return 0;

    this.totalLinesWritten += lines.length;
    if (this.fullOutput !== undefined && this.fullOutputBytes < this.maxFullOutputBytes) {
      this.fullOutput.push(text);
      this.fullOutputBytes += byteLength(text);
    }

    let charsWritten = 0;
    for (const originalLine of lines) {
      // The per-line cap applies before the budget check: an over-long line is
      // first reduced to its own cap, and only then judged against what is left
      // of the head budget. Checking the raw length first pushed ordinary long
      // lines straight into the tail and skipped their cap entirely.
      let line = originalLine;
      if (this.maxLineBytes !== null && byteLength(line) > this.maxLineBytes) {
        line = truncateLineToBytes(line, this.maxLineBytes);
        this.truncationHappened = true;
      }

      const lineBytes = byteLength(line);
      const remainingHeadBytes = this.maxBytes - this.nBytesValue;
      const fitsHead =
        !this.headTruncated &&
        this.linesInHead < this.maxLines &&
        lineBytes <= remainingHeadBytes;

      if (fitsHead) {
        this.pushHead(line);
        charsWritten += line.length;
        continue;
      }

      // A single line that exceeds the whole head on its own (a 200 KB stream
      // without newlines): keeping whole-line granularity here would throw away
      // the beginning entirely and leave only the marker plus the tail. Keeping
      // a character-safe prefix is the cheaper loss, and it is the only case
      // where the head is allowed to end mid-line.
      if (
        !this.headTruncated &&
        this.linesInHead === 0 &&
        lineBytes > remainingHeadBytes &&
        remainingHeadBytes > 0
      ) {
        const prefix = truncateToBytes(line, remainingHeadBytes);
        this.pushHead(prefix);
        this.headTruncated = true;
        this.truncationHappened = true;
        const rest = line.slice(prefix.length);
        if (rest.length > 0) this.appendTail(rest);
        charsWritten += line.length;
        continue;
      }

      // Whole lines only past this point: the budget is full or the line does
      // not fit. The line starts the tail window.
      this.headTruncated = true;
      this.truncationHappened = true;
      this.appendTail(line);
      charsWritten += line.length;
    }

    return charsWritten;
  }

  private pushHead(line: string): void {
    this.buffer.push(line);
    this.nBytesValue += byteLength(line);
    this.nCharsValue += line.length;
    this.linesInHead += 1;
  }

  private appendTail(text: string): void {
    if (text.length === 0) return;
    if (this.maxTailBytes === 0) return;

    const bytes = byteLength(text);
    if (bytes >= this.maxTailBytes) {
      const trimmed = tailAtCodePoint(text, this.maxTailBytes);
      this.tailBuf.length = 0;
      this.tailBuf.push(trimmed);
      this.tailBytesValue = byteLength(trimmed);
      this.tailCharsValue = trimmed.length;
      return;
    }

    this.tailBuf.push(text);
    this.tailBytesValue += bytes;
    this.tailCharsValue += text.length;
    if (this.tailBytesValue > this.maxTailBytes * 2) {
      this.trimTail();
    }
  }

  private trimTail(): void {
    if (this.tailBytesValue <= this.maxTailBytes) return;
    const joined = this.tailBuf.join('');
    const trimmed = tailAtCodePoint(joined, this.maxTailBytes);
    this.tailBuf.length = 0;
    this.tailBuf.push(trimmed);
    this.tailBytesValue = byteLength(trimmed);
    this.tailCharsValue = trimmed.length;
  }

  private computeElidedLines(head: string, tail: string): number {
    if (this.totalLinesWritten === 0) return 0;
    // Prefer the retained full output for an exact count; fall back to the
    // streaming line counter when no artifact sink is configured.
    if (this.fullOutput !== undefined) {
      const total = countLines(this.fullOutput.join(''));
      return Math.max(0, total - countLines(head) - countLines(tail));
    }
    return Math.max(0, this.totalLinesWritten - countLines(head) - countLines(tail));
  }

  private async maybeWriteArtifact(): Promise<string | undefined> {
    if (this.artifactSink === undefined || this.fullOutput === undefined) return undefined;
    if (!this.truncationHappened) return undefined;
    const full = this.fullOutput.join('');
    if (full.length === 0) return undefined;
    try {
      return await this.artifactSink(full);
    } catch {
      // A failing sink must never break the tool result; the truncated output
      // (with its elided-line count) still stands on its own.
      return undefined;
    }
  }

  private appendArtifactRef(output: string, ref: string): string {
    const line = `[full output saved: ${ref}]`;
    return output.length === 0
      ? line
      : output.endsWith('\n')
        ? `${output}${line}`
        : `${output}\n${line}`;
  }

  async ok(
    message = '',
    options: { readonly brief?: string } = {},
  ): Promise<ExecutableToolResultBuilderResult> {
    let finalMessage = message;
    if (finalMessage.length > 0 && !finalMessage.endsWith('.')) {
      finalMessage += '.';
    }
    if (this.truncationHappened) {
      finalMessage =
        finalMessage.length === 0 ? TRUNCATION_MESSAGE : `${finalMessage} ${TRUNCATION_MESSAGE}`;
    }

    const baseOutput = this.toString();
    const artifactRef = await this.maybeWriteArtifact();
    const output =
      artifactRef === undefined ? baseOutput : this.appendArtifactRef(baseOutput, artifactRef);

    const shouldAppendMessage =
      finalMessage.length > 0 && (this.truncationHappened || output.length === 0);
    return {
      isError: false,
      output: shouldAppendMessage
        ? output.length === 0
          ? finalMessage
          : output.endsWith('\n')
            ? `${output}${finalMessage}`
            : `${output}\n${finalMessage}`
        : output,
      // The UI renders both `output` and `message`; when the brief is already
      // folded into the output, leave the side channel empty so the same
      // line is not shown twice.
      message: shouldAppendMessage ? undefined : finalMessage,
      truncated: this.truncationHappened,
      brief: options.brief,
    };
  }

  async error(
    message: string,
    options: { readonly brief?: string } = {},
  ): Promise<ExecutableToolResultBuilderResult> {
    const finalMessage = this.truncationHappened
      ? message.length === 0
        ? TRUNCATION_MESSAGE
        : `${message} ${TRUNCATION_MESSAGE}`
      : message;

    const baseOutput = this.toString();
    const artifactRef = await this.maybeWriteArtifact();
    const output =
      artifactRef === undefined ? baseOutput : this.appendArtifactRef(baseOutput, artifactRef);

    return {
      isError: true,
      output:
        finalMessage.length === 0
          ? output
          : output.length === 0
            ? finalMessage
            : output.endsWith('\n')
              ? `${output}${finalMessage}`
              : `${output}\n${finalMessage}`,
      // `finalMessage` is always folded into the output above; do not repeat
      // it on the side channel — the UI renders both and would show it twice.
      truncated: this.truncationHappened,
      brief: options.brief,
    };
  }
}

/** UTF-8 byte length; the budget unit for every tool result. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Cut `text` to a byte budget without splitting a character.
 *
 * The cut backs up to the lead byte of the sequence it would have split, so the
 * result decodes to complete code points — no lone surrogate, no U+FFFD.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (text.length === 0) return text;
  if (byteLength(text) <= maxBytes) return text;

  const bytes = Buffer.from(text, 'utf8');
  let end = Math.min(maxBytes, bytes.length);
  // A continuation byte (0b10xxxxxx) belongs to the character before it.
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return bytes.toString('utf8', 0, end);
}

/** Last `maxBytes` bytes of `text`, starting on a character boundary. */
export function tailToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (text.length === 0) return text;
  if (byteLength(text) <= maxBytes) return text;

  const bytes = Buffer.from(text, 'utf8');
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
  return bytes.toString('utf8', start);
}

/**
 * A single over-long line keeps its head and the truncation marker, and the cut
 * lands on a character boundary. The marker (and any trailing line break) is
 * reserved out of the same budget.
 */
function truncateLineToBytes(line: string, maxLineBytes: number): string {
  const lineBreak = /[\r\n]+$/.exec(line)?.[0] ?? '';
  const suffix = TRUNCATION_MARKER + lineBreak;
  const keep = Math.max(0, maxLineBytes - byteLength(suffix));
  const body = truncateToBytes(line.slice(0, line.length - lineBreak.length), keep);
  return `${body}${suffix}`;
}

function tailAtCodePoint(text: string, maxBytes: number): string {
  return tailToBytes(text, maxBytes);
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  // A trailing newline produces a trailing empty element that is not a real line.
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
