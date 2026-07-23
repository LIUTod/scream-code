import { createHash } from 'node:crypto';

import type { Jian, StatResult } from '@scream-code/jian';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { renderPrompt } from '../../../utils/render-prompt';
import { resolvePathAccessPath } from '../../policies/path-access';
import { MEDIA_SNIFF_BYTES, detectFileType } from '../../support/file-type';
import { toInputJsonSchema } from '../../support/input-schema';
import { listDirectory } from '../../support/list-directory';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import {
  findUniqueSuffixMatch,
  suffixResolutionNotice,
} from '../../support/suffix-match';
import type { WorkspaceConfig } from '../../support/workspace';
import { makeCarriageReturnsVisible, type LineEndingStyle } from './line-endings';
import { formatConflictNotice, scanConflictLines } from './conflict-detect';
import readDescriptionTemplate from './read.md';

export const MAX_LINES: number = 1000;
export const MAX_LINE_LENGTH: number = 2000;
export const MAX_BYTES: number = 100 * 1024;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

const PositiveLineOffsetSchema = z.number().int().min(1);
const TailLineOffsetSchema = z.number().int().min(-MAX_LINES).max(-1);

export const ReadInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to a text file. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use `ls` via Bash for a known directory, or Glob for pattern search.',
    ),
  line_offset: z
    .union([PositiveLineOffsetSchema, TailLineOffsetSchema])
    .optional()
    .describe(
      `The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file; the absolute value cannot exceed ${String(MAX_LINES)}.`,
    ),
  n_lines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `The number of lines to read; the tool also applies its internal cap. Omit to read up to the internal cap of ${String(MAX_LINES)} lines.`,
    ),
});

export const ReadOutputSchema = z.object({
  content: z.string(),
  lineCount: z.number().int().nonnegative(),
});

export type ReadInput = z.Infer<typeof ReadInputSchema>;
export type ReadOutput = z.Infer<typeof ReadOutputSchema>;

interface LineEndingFlags {
  hasCrLf: boolean;
  hasLf: boolean;
  hasLoneCr: boolean;
}

interface ReadLineEntry {
  readonly lineNo: number;
  readonly rawContent: string;
}

interface RenderedLine {
  readonly line: string;
  readonly wasTruncated: boolean;
}

interface FinishReadResultInput {
  readonly renderedLines: readonly string[];
  readonly truncatedLineNumbers: readonly number[];
  readonly maxLinesReached: boolean;
  readonly maxBytesReached: boolean;
  readonly lineEndingStyle: LineEndingStyle;
  readonly startLine: number;
  readonly totalLines: number;
  readonly requestedLines: number;
  readonly anchor: string;
}

function truncateLine(line: string, maxLength: number): string {
  if (line.length <= maxLength) return line;
  const marker = '...';
  const target = Math.max(maxLength, marker.length);
  return line.slice(0, target - marker.length) + marker;
}

function stripTrailingLf(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

function updateLineEndingFlags(flags: LineEndingFlags, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i);
    if (code === 13) {
      if (text.codePointAt(i + 1) === 10) {
        flags.hasCrLf = true;
        i += 1;
      } else {
        flags.hasLoneCr = true;
      }
    } else if (code === 10) {
      flags.hasLf = true;
    }
  }
}

function lineEndingStyleFromFlags(flags: LineEndingFlags): LineEndingStyle {
  if (flags.hasLoneCr || (flags.hasCrLf && flags.hasLf)) return 'mixed';
  if (flags.hasCrLf) return 'crlf';
  return 'lf';
}

function renderLine(entry: ReadLineEntry, lineEndingStyle: LineEndingStyle): RenderedLine {
  const modelContent =
    lineEndingStyle === 'crlf' && entry.rawContent.endsWith('\r')
      ? entry.rawContent.slice(0, -1)
      : entry.rawContent;
  const truncated = truncateLine(modelContent, MAX_LINE_LENGTH);
  const renderedContent =
    lineEndingStyle === 'mixed' ? makeCarriageReturnsVisible(truncated) : truncated;
  return {
    line: `${String(entry.lineNo)}\t${renderedContent}`,
    wasTruncated: truncated !== modelContent,
  };
}

function renderedLineBytes(renderedLine: string, isFirst: boolean): number {
  return (isFirst ? 0 : 1) + Buffer.byteLength(renderedLine, 'utf8');
}

function isRegularFileMode(stMode: number): boolean {
  return (stMode & S_IFMT) === S_IFREG;
}

function isFileNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown })['code'];
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// Prepend a notice line to a read result. The notice sits above the file
// content and outside the <system>...</system> block, so ReadGroup's
// `</system>\s*$` end-anchor regex still matches.
function prependNotice(result: ExecutableToolResult, notice: string): ExecutableToolResult {
  if (typeof result.output === 'string') {
    const prefixed = result.output.length > 0 ? `${notice}\n${result.output}` : notice;
    return { ...result, output: prefixed };
  }
  return { ...result, output: [{ type: 'text', text: notice }, ...result.output] };
}

function isTextDecodeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown })['code'];
  if (code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return true;
  if (!(error instanceof Error)) return false;
  return /encoded data was not valid|invalid.*encoding|invalid.*utf-?8/i.test(error.message);
}

function containsNulByte(text: string): boolean {
  return text.includes('\u0000');
}

function notReadableFileOutput(path: string): string {
  return (
    `"${path}" is not readable as UTF-8 text. ` +
    'If it is an image or video, use ReadMediaFile. ' +
    'For other binary formats, use Bash or an MCP tool if available.'
  );
}

const READ_DESCRIPTION = renderPrompt(readDescriptionTemplate, {
  MAX_LINES,
  MAX_BYTES_KB: MAX_BYTES / 1024,
  MAX_LINE_LENGTH,
});

export class ReadTool implements BuiltinTool<ReadInput> {
  readonly name = 'Read' as const;
  readonly description = READ_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadInputSchema);
  constructor(
    private readonly jian: Jian,
    private readonly workspace: WorkspaceConfig,
  ) {}

  async resolveExecution(args: ReadInput): Promise<ToolExecution> {
    const path = await resolvePathAccessPath(args.path, {
      jian: this.jian,
      workspace: this.workspace,
      operation: 'read',
    });
    return {
      accesses: ToolAccesses.readFile(path),
      description: `Reading ${args.path}`,
      display: { kind: 'file_io', operation: 'read', path },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: this.jian.pathClass(),
          homeDir: this.jian.gethome(),
        }),
      execute: () => this.execution(args, path),
    };
  }

  // Attempt suffix-match recovery on ENOENT. Glob **/<basename> under the
  // workspace root; on a unique hit, re-run the full read pipeline against
  // the matched path with a notice prepended. Returns null to fall through
  // to the normal does-not-exist error. Mirrors omp findUniqueSuffixMatch.
  private async trySuffixMatchRead(
    args: ReadInput,
  ): Promise<ExecutableToolResult | null> {
    const suffixMatch = await findUniqueSuffixMatch(
      args.path,
      this.workspace.workspaceDir,
      this.jian,
    );
    if (suffixMatch === null) return null;
    try {
      const retryStat = await this.jian.stat(suffixMatch.absolutePath);
      if (!isRegularFileMode(retryStat.stMode)) return null;
    } catch {
      return null;
    }
    const notice = suffixResolutionNotice(args.path, suffixMatch.displayPath);
    const inner = await this.execution(args, suffixMatch.absolutePath, true);
    return prependNotice(inner, notice);
  }

  private async fileNotFoundResult(displayPath: string): Promise<ExecutableToolResult> {
    let tree: string;
    try {
      tree = await listDirectory(this.jian, this.workspace.workspaceDir);
    } catch {
      tree = '(listing unavailable)';
    }
    return {
      isError: true,
      output:
        `"${displayPath}" does not exist.\n\n` +
        `Top of ${this.workspace.workspaceDir}:\n${tree}`,
    };
  }

  private async execution(
    args: ReadInput,
    safePath: string,
    suffixResolved = false,
  ): Promise<ExecutableToolResult> {
    try {
      let stat: StatResult;
      try {
        stat = await this.jian.stat(safePath);
      } catch (error) {
        if (isFileNotFoundError(error)) {
          if (!suffixResolved) {
            const resolved = await this.trySuffixMatchRead(args);
            if (resolved !== null) return resolved;
          }
          return await this.fileNotFoundResult(args.path);
        }
        throw error;
      }
      if (!isRegularFileMode(stat.stMode)) {
        return { isError: true, output: `"${args.path}" is not a file.` };
      }

      const header = await this.jian.readBytes(safePath, MEDIA_SNIFF_BYTES);
      const fileType = detectFileType(safePath, header);
      if (fileType.kind === 'image' || fileType.kind === 'video') {
        return {
          isError: true,
          output: `"${args.path}" is a ${fileType.kind} file. Use ReadMediaFile to read image or video files.`,
        };
      }
      if (fileType.kind === 'unknown') {
        return {
          isError: true,
          output: notReadableFileOutput(args.path),
        };
      }

      const lineOffset = args.line_offset ?? 1;
      const requestedLines = args.n_lines ?? MAX_LINES;
      const effectiveLimit = Math.min(requestedLines, MAX_LINES);

      if (lineOffset < 0) {
        return await this.readTail(
          safePath,
          args.path,
          lineOffset,
          effectiveLimit,
          requestedLines,
        );
      }
      return await this.readForward(
        safePath,
        args.path,
        lineOffset,
        effectiveLimit,
        requestedLines,
      );
    } catch (error) {
      if (isTextDecodeError(error)) {
        return { isError: true, output: notReadableFileOutput(args.path) };
      }
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async readForward(
    safePath: string,
    displayPath: string,
    lineOffset: number,
    effectiveLimit: number,
    requestedLines: number,
  ): Promise<ExecutableToolResult> {
    const selectedEntries: ReadLineEntry[] = [];
    const flags: LineEndingFlags = { hasCrLf: false, hasLf: false, hasLoneCr: false };
    // Feed the full-file anchor hash incrementally (raw + CRLF-normalized)
    // instead of buffering every line — a multi-GB file must not OOM when
    // the caller only asked for 50 lines.
    const rawHash = createHash('sha256');
    const normalizedHash = createHash('sha256');
    let currentLineNo = 0;
    let maxLinesReached = false;
    let collectionClosed = false;

    for await (const rawLine of this.jian.readLines(safePath, { errors: 'strict' })) {
      if (containsNulByte(rawLine)) {
        return { isError: true, output: notReadableFileOutput(displayPath) };
      }
      currentLineNo += 1;
      updateLineEndingFlags(flags, rawLine);
      rawHash.update(rawLine);
      normalizedHash.update(rawLine.replaceAll('\r\n', '\n'));
      if (collectionClosed) {
        if (effectiveLimit >= MAX_LINES && currentLineNo >= lineOffset) {
          maxLinesReached = true;
        }
        continue;
      }
      if (currentLineNo < lineOffset) continue;
      if (selectedEntries.length >= effectiveLimit) {
        if (effectiveLimit >= MAX_LINES) {
          maxLinesReached = true;
        }
        collectionClosed = true;
        continue;
      }
      selectedEntries.push({
        lineNo: currentLineNo,
        rawContent: stripTrailingLf(rawLine),
      });
      if (selectedEntries.length >= effectiveLimit) {
        collectionClosed = true;
      }
    }

    const lineEndingStyle = lineEndingStyleFromFlags(flags);
    const anchor = (lineEndingStyle === 'crlf' ? normalizedHash : rawHash).digest('hex').slice(0, 8);
    const renderedLines: string[] = [];
    const truncatedLineNumbers: number[] = [];
    let bytes = 0;
    let maxBytesReached = false;

    for (const entry of selectedEntries) {
      const rendered = renderLine(entry, lineEndingStyle);
      const lineBytes = renderedLineBytes(rendered.line, renderedLines.length === 0);
      if (renderedLines.length > 0 && bytes + lineBytes > MAX_BYTES) {
        maxBytesReached = true;
        break;
      }

      if (rendered.wasTruncated) {
        truncatedLineNumbers.push(entry.lineNo);
      }
      renderedLines.push(rendered.line);
      bytes += lineBytes;
      if (bytes >= MAX_BYTES) {
        maxBytesReached = true;
        break;
      }
    }

    return this.finishReadResult({
      renderedLines,
      truncatedLineNumbers,
      maxLinesReached,
      maxBytesReached,
      lineEndingStyle,
      startLine: renderedLines.length > 0 ? lineOffset : 0,
      totalLines: currentLineNo,
      requestedLines,
      anchor,
    });
  }

  private async readTail(
    safePath: string,
    displayPath: string,
    lineOffset: number,
    effectiveLimit: number,
    requestedLines: number,
  ): Promise<ExecutableToolResult> {
    const tailCount = Math.abs(lineOffset);
    const entries: ReadLineEntry[] = [];
    const flags: LineEndingFlags = { hasCrLf: false, hasLf: false, hasLoneCr: false };
    const rawHash = createHash('sha256');
    const normalizedHash = createHash('sha256');
    let currentLineNo = 0;

    for await (const rawLine of this.jian.readLines(safePath, { errors: 'strict' })) {
      if (containsNulByte(rawLine)) {
        return { isError: true, output: notReadableFileOutput(displayPath) };
      }
      currentLineNo += 1;
      updateLineEndingFlags(flags, rawLine);
      rawHash.update(rawLine);
      normalizedHash.update(rawLine.replaceAll('\r\n', '\n'));
      entries.push({
        lineNo: currentLineNo,
        rawContent: stripTrailingLf(rawLine),
      });
      if (entries.length > tailCount) {
        entries.shift();
      }
    }

    const lineEndingStyle = lineEndingStyleFromFlags(flags);
    const anchor = (lineEndingStyle === 'crlf' ? normalizedHash : rawHash).digest('hex').slice(0, 8);
    let renderedCandidates = entries.slice(0, effectiveLimit).map((entry) => {
      return { entry, rendered: renderLine(entry, lineEndingStyle) };
    });

    let totalBytes = 0;
    for (const [index, candidate] of renderedCandidates.entries()) {
      totalBytes += renderedLineBytes(candidate.rendered.line, index === 0);
    }

    let maxBytesReached = false;
    if (totalBytes > MAX_BYTES) {
      maxBytesReached = true;
      const kept: typeof renderedCandidates = [];
      let bytes = 0;
      for (let i = renderedCandidates.length - 1; i >= 0; i -= 1) {
        const candidate = renderedCandidates[i];
        if (candidate === undefined) continue;
        const lineBytes = renderedLineBytes(candidate.rendered.line, kept.length === 0);
        if (bytes + lineBytes > MAX_BYTES) break;
        kept.unshift(candidate);
        bytes += lineBytes;
      }
      renderedCandidates = kept;
    }

    const renderedLines: string[] = [];
    const truncatedLineNumbers: number[] = [];
    for (const candidate of renderedCandidates) {
      renderedLines.push(candidate.rendered.line);
      if (candidate.rendered.wasTruncated) {
        truncatedLineNumbers.push(candidate.entry.lineNo);
      }
    }

    return this.finishReadResult({
      renderedLines,
      truncatedLineNumbers,
      maxLinesReached: false,
      maxBytesReached,
      lineEndingStyle,
      startLine: renderedCandidates[0]?.entry.lineNo ?? 0,
      totalLines: currentLineNo,
      requestedLines,
      anchor,
    });
  }

  private finishReadResult(input: FinishReadResultInput): ExecutableToolResult {
    const message = this.finishMessage(input);
    // Scan the returned window (not the whole file) for merge conflict
    // markers so the agent is warned before editing a conflicted file. Strip
    // the `NNN\t` line-number prefix renderLine adds before scanning. The
    // notice is appended to the system message (inside <system>…</system>)
    // so the ReadGroup parser's `</system>\s*$` regex still matches.
    const rawLines = input.renderedLines.map((l) => {
      const tabIdx = l.indexOf('\t');
      return tabIdx === -1 ? l : l.slice(tabIdx + 1);
    });
    const notice = formatConflictNotice(scanConflictLines(rawLines, input.startLine));
    const fullMessage = notice.length > 0 ? `${message} ${notice}` : message;
    return { output: this.finishOutput(input.renderedLines, fullMessage) };
  }

  private finishOutput(renderedLines: readonly string[], message: string): string {
    const rendered = renderedLines.join('\n');
    const status = `<system>${message}</system>`;
    return rendered.length > 0 ? `${rendered}\n${status}` : status;
  }

  private finishMessage(input: FinishReadResultInput): string {
    const lineCount = input.renderedLines.length;
    const lineWord = lineCount === 1 ? 'line' : 'lines';
    const parts =
      lineCount > 0
        ? [
            `${String(lineCount)} ${lineWord} read from file starting from line ${String(input.startLine)}.`,
          ]
        : ['No lines read from file.'];

    parts.push(`Total lines in file: ${String(input.totalLines)}.`);
    if (input.maxLinesReached) {
      parts.push(`Max ${String(MAX_LINES)} lines reached.`);
    } else if (input.maxBytesReached) {
      parts.push(`Max ${String(MAX_BYTES)} bytes reached.`);
    } else if (lineCount < input.requestedLines) {
      parts.push('End of file reached.');
    }
    if (input.truncatedLineNumbers.length > 0) {
      parts.push(`Lines [${input.truncatedLineNumbers.join(', ')}] were truncated.`);
    }
    if (input.lineEndingStyle === 'mixed') {
      parts.push(
        'Mixed or lone carriage-return line endings are shown as \\r. Use exact \\r\\n or \\r escapes in Edit.old_string for those lines.',
      );
    }
    parts.push(`Anchor: ${input.anchor}`);
    return parts.join(' ');
  }
}
