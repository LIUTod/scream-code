import type {
  ExecutableToolErrorResult,
  ExecutableToolSuccessResult,
} from '../../loop/types';

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TAIL_CHARS = 20_000;
const DEFAULT_MAX_LINE_LENGTH = 2000;
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
  readonly maxChars?: number;
  readonly maxTailChars?: number;
  readonly maxLineLength?: number | null;
  /**
   * When provided, the builder retains the full output in memory and offloads
   * it through this sink on truncation, appending the returned reference so the
   * elided middle becomes recoverable. Omit to keep the streaming/forget memory
   * profile and skip artifact offloading.
   */
  readonly artifactSink?: ArtifactSink;
  /** Maximum characters of full output to retain in memory for artifact
   * offloading. Defaults to 1 MB. Once exceeded, the builder stops
   * accumulating (the head/tail truncation still works, but the artifact
   * will only contain the first `maxFullOutputChars` of output). */
  readonly maxFullOutputChars?: number;
}

export type ExecutableToolResultBuilderResult = (
  | ExecutableToolSuccessResult
  | ExecutableToolErrorResult
) & {
  readonly output: string;
  readonly message: string;
  readonly truncated: boolean;
  readonly brief?: string;
};

export class ToolResultBuilder {
  private readonly maxChars: number;
  private readonly maxTailChars: number;
  private readonly maxLineLength: number | null;
  private readonly artifactSink?: ArtifactSink;
  private readonly maxFullOutputChars: number;

  private readonly buffer: string[] = [];
  private nCharsValue = 0;
  private truncationHappened = false;
  private headTruncated = false;

  private readonly tailBuf: string[] = [];
  private tailCharsValue = 0;

  // Full-output retention is only enabled when an artifactSink is configured,
  // so the default streaming/forget memory profile is unchanged. totalLinesWritten
  // feeds the "N lines elided" counter shown on head+tail truncation.
  private readonly fullOutput?: string[];
  private fullOutputChars = 0;
  private totalLinesWritten = 0;

  constructor(options: ToolResultBuilderOptions = {}) {
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.maxTailChars = options.maxTailChars ?? DEFAULT_TAIL_CHARS;
    this.maxLineLength =
      options.maxLineLength === undefined ? DEFAULT_MAX_LINE_LENGTH : options.maxLineLength;

    if (this.maxLineLength !== null && this.maxLineLength <= TRUNCATION_MARKER.length) {
      throw new Error('maxLineLength must be greater than the truncation marker length.');
    }
    this.artifactSink = options.artifactSink;
    this.maxFullOutputChars = options.maxFullOutputChars ?? 1_000_000;
    if (this.artifactSink !== undefined) {
      this.fullOutput = [];
    }
  }

  get nChars(): number {
    return this.nCharsValue + this.tailCharsValue;
  }

  toString(): string {
    const head = this.buffer.join('');
    if (!this.headTruncated || this.tailCharsValue === 0) {
      return head;
    }
    this.trimTail();
    const tail = this.tailBuf.join('');
    const separator = head.endsWith('\n') ? '' : '\n';
    const elided = this.computeElidedLines(head, tail);
    const marker =
      elided > 0
        ? `[…${String(elided)} lines elided…]\n${TRUNCATION_MARKER}`
        : TRUNCATION_MARKER;
    return `${head}${separator}${marker}\n${tail}`;
  }

  write(text: string): number {
    if (text.length === 0) return 0;

    const lines = text.match(/[^\r\n]*(?:\r\n|[\n\r])|[^\r\n]+/g) ?? [];
    if (lines.length === 0) return 0;

    this.totalLinesWritten += lines.length;
    if (this.fullOutput !== undefined && this.fullOutputChars < this.maxFullOutputChars) {
      this.fullOutput.push(text);
      this.fullOutputChars += text.length;
    }

    let charsWritten = 0;
    for (const originalLine of lines) {
      if (this.nCharsValue < this.maxChars) {
        const remainingChars = this.maxChars - this.nCharsValue;
        const limit =
          this.maxLineLength === null
            ? remainingChars
            : Math.min(remainingChars, this.maxLineLength);
        let line = originalLine;
        if (line.length > limit) {
          const lineBreak = /[\r\n]+$/.exec(line)?.[0] ?? '';
          const suffix = TRUNCATION_MARKER + lineBreak;
          const effectiveMaxLength = Math.max(limit, suffix.length);
          line = line.slice(0, effectiveMaxLength - suffix.length) + suffix;
          this.truncationHappened = true;
        }

        this.buffer.push(line);
        charsWritten += line.length;
        this.nCharsValue += line.length;
        if (this.nCharsValue >= this.maxChars) {
          this.headTruncated = true;
          this.truncationHappened = true;
        }
      } else {
        this.appendTail(originalLine);
        charsWritten += originalLine.length;
        this.headTruncated = true;
        this.truncationHappened = true;
      }
    }

    return charsWritten;
  }

  private appendTail(text: string): void {
    if (text.length === 0) return;
    if (this.maxTailChars === 0) return;

    if (text.length >= this.maxTailChars) {
      const trimmed = text.slice(-this.maxTailChars);
      this.tailBuf.length = 0;
      this.tailBuf.push(trimmed);
      this.tailCharsValue = trimmed.length;
      return;
    }

    this.tailBuf.push(text);
    this.tailCharsValue += text.length;
    if (this.tailCharsValue > this.maxTailChars * 2) {
      this.trimTail();
    }
  }

  private trimTail(): void {
    if (this.tailCharsValue <= this.maxTailChars) return;
    const joined = this.tailBuf.join('');
    const trimmed = joined.slice(-this.maxTailChars);
    this.tailBuf.length = 0;
    this.tailBuf.push(trimmed);
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
      message: finalMessage,
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
      message: finalMessage,
      truncated: this.truncationHappened,
      brief: options.brief,
    };
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  // A trailing newline produces a trailing empty element that is not a real line.
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
