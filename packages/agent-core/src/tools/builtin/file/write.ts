/**
 * WriteTool — overwrite or append to a file.
 *
 * Creates the file if it does not exist; parent directory must already exist.
 * Path access policy is resolved before any Jian I/O.
 */

import type { Jian } from '@scream-code/jian';
import { dirname } from 'pathe';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { LspRegistry } from '../../../lsp/registry';
import type { ToolResultDisplay } from '../../display';
import { resolvePathAccessPath } from '../../policies/path-access';
import { countLines, fileDiffSummary } from '../../support/file-diff';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import { scanCache } from '../../support/scan-cache';
import type { WorkspaceConfig } from '../../support/workspace';
import { scanConflictLines } from './conflict-detect';
import { fetchDiagnostics, formatDiagnosticsHint, formatDiagnosticsNotice } from './lsp-diagnostics';
import WRITE_DESCRIPTION from './write.md';

/** Mask isolating the file-type bits of a stat mode. */
const S_IFMT = 0o170000;
/** File-type bits of a directory. */
const S_IFDIR = 0o040000;

/**
 * Size ceiling (bytes, from `stat`) for reading the pre-write text that feeds
 * the `file_diff` display. Mirrors the guard inside `fileDiffSummary`: past it
 * the diff is skipped anyway, so the file is never read only to be discarded.
 */
const MAX_DIFF_SOURCE_BYTES = 1_000_000;

/**
 * Pre-write state of the write target, collected solely to build the
 * `file_diff` display. `missing` means this call creates the file;
 * `unavailable` means the state could not be established (oversized,
 * unreadable, or a failing stat) and the display is omitted rather than
 * guessed.
 */
type ExistingText =
  | { readonly kind: 'missing' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'unavailable' };

export const WriteInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. The parent directory must already exist.',
    ),
  content: z
    .string()
    .describe(
      'Raw full file content to write exactly as provided. This does not use the Read/Edit text view.',
    ),
  mode: z
    .enum(['overwrite', 'append'])
    .optional()
    .describe(
      'Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.',
    ),
});

export const WriteOutputSchema = z.object({
  /** Number of UTF-8 bytes written to disk by this call. */
  bytesWritten: z.number().int().nonnegative(),
});

export type WriteInput = z.Infer<typeof WriteInputSchema>;
export type WriteOutput = z.Infer<typeof WriteOutputSchema>;

export class WriteTool implements BuiltinTool<WriteInput> {
  readonly name = 'Write' as const;
  readonly description = WRITE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WriteInputSchema);

  constructor(
    private readonly jian: Jian,
    private readonly workspace: WorkspaceConfig,
    private readonly lspRegistry?: LspRegistry,
  ) {}

  async resolveExecution(args: WriteInput): Promise<ToolExecution> {
    const path = await resolvePathAccessPath(args.path, {
      jian: this.jian,
      workspace: this.workspace,
      operation: 'write',
    });
    return {
      accesses: ToolAccesses.writeFile(path),
      description: `Writing ${args.path}`,
      display: { kind: 'file_io', operation: 'write', path, content: args.content },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: this.jian.pathClass(),
          homeDir: this.jian.gethome(),
        }),
      execute: ({ signal }) => this.execution(args, path, signal),
    };
  }

  private async execution(
    args: WriteInput,
    safePath: string,
    signal?: AbortSignal,
  ): Promise<ExecutableToolResult> {
    signal?.throwIfAborted();
    const parentError = await this.checkParentDirectory(safePath);
    if (parentError !== undefined) {
      return { isError: true, output: parentError };
    }

    const contentBlocks = scanConflictLines(args.content.split('\n'));
    if (contentBlocks.length > 0) {
      const blockList = contentBlocks
        .map((b) => `lines ${String(b.startLine)}-${String(b.endLine)}`)
        .join(', ');
      return {
        isError: true,
        output:
          `Content contains merge conflict markers (${blockList}). ` +
          'Resolve the conflict before writing. Merge conflict markers (<<<<<<< / ======= / >>>>>>>) indicate an unresolved merge.',
      };
    }

    try {
      const mode = args.mode ?? 'overwrite';
      // Best-effort pre-write read for the `file_diff` display. It must never
      // affect write semantics: every read failure is folded into `unavailable`
      // so the write proceeds untouched.
      const existing = await this.readExistingText(safePath);
      const display: ToolResultDisplay | undefined =
        mode === 'append'
          ? this.appendFileDiffDisplay(args.content, existing)
          : this.overwriteFileDiffDisplay(args.content, existing);
      if (mode === 'append') {
        await this.jian.writeText(safePath, args.content, { mode: 'a' });
      } else {
        await this.jian.writeText(safePath, args.content);
      }
      scanCache.clear();
      // Report the number of UTF-8 bytes this call wrote to disk. The string
      // length would only equal the byte count for pure ASCII content, so it
      // is not used here.
      const bytesWritten = Buffer.byteLength(args.content, 'utf8');
      const { notice, hasErrors } = await this.appendDiagnostics(safePath);
      // Diagnostics go to `message` (side channel for the UI) instead of
      // contaminating `output`, so Write's result stays a single line and the
      // TUI doesn't double-collapse the content preview + result output.
      const output = `${mode === 'append' ? 'Appended' : 'Wrote'} ${String(bytesWritten)} bytes to ${args.path}`;
      const message = notice.length > 0 ? notice : undefined;
      if (hasErrors) return { isError: true, output, message };
      return display === undefined ? { output, message } : { output, message, display };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ENOENT') {
        return {
          isError: true,
          output: `Failed to write ${args.path}: parent directory does not exist.`,
        };
      }
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Compute the `file_diff` line counts for an append.
   *
   * Appending concatenates bytes, so a file that does not end with a newline has
   * its last line rewritten by the first appended line — counting only the new
   * content (`+N -0`) would hide that rewritten line. Diffing the real pre-write
   * text against that text plus the new content is exact; a target that does not
   * exist yet can only gain lines.
   */
  private appendFileDiffDisplay(
    content: string,
    existing: ExistingText,
  ): ToolResultDisplay | undefined {
    if (existing.kind === 'unavailable') return undefined;
    const before = existing.kind === 'missing' ? '' : existing.text;
    const summary = fileDiffSummary(before, before + content);
    if (summary === undefined) return undefined;
    return { kind: 'file_diff', added: summary.added, removed: summary.removed };
  }

  /**
   * Compute the `file_diff` line counts for an overwrite.
   *
   * A file that does not exist yet can only gain lines, so the argument-derived
   * count is exact there. Otherwise the previous text is diffed against the
   * new text, which is the only way to see the removed lines an overwrite
   * destroys. Returns `undefined` (no display) when the previous text is
   * unknown or too large to diff.
   */
  private overwriteFileDiffDisplay(
    content: string,
    existing: ExistingText,
  ): ToolResultDisplay | undefined {
    if (existing.kind === 'missing') {
      return { kind: 'file_diff', added: countLines(content), removed: 0 };
    }
    if (existing.kind === 'unavailable') return undefined;
    const summary = fileDiffSummary(existing.text, content);
    if (summary === undefined) return undefined;
    return { kind: 'file_diff', added: summary.added, removed: summary.removed };
  }

  /**
   * Best-effort read of the text this call is about to overwrite, for the
   * `file_diff` display only.
   *
   * The `stat` size check runs first so an oversized file is never pulled into
   * memory just to be diffed. A failing `stat` for any reason other than
   * `ENOENT` is inconclusive, so the read is still attempted.
   */
  private async readExistingText(safePath: string): Promise<ExistingText> {
    try {
      const info = await this.jian.stat(safePath);
      if (info.stSize > MAX_DIFF_SOURCE_BYTES) return { kind: 'unavailable' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { kind: 'missing' };
    }
    try {
      return { kind: 'text', text: await this.jian.readText(safePath) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'unavailable' };
    }
  }

  /**
   * Best-effort check that the parent directory exists and is a directory.
   *
   * The path schema documents this precondition; probing it up front turns a
   * bare `ENOENT` from the underlying write into an actionable message.
   * Returns an error string when the precondition is definitively violated,
   * or `undefined` otherwise. Any other `stat` failure (permissions, an
   * environment without `stat`) is treated as inconclusive: the check is
   * skipped and the write proceeds, surfacing the real I/O error if any.
   */
  private async checkParentDirectory(safePath: string): Promise<string | undefined> {
    const parent = dirname(safePath);
    let stat;
    try {
      stat = await this.jian.stat(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return `Parent directory does not exist: ${parent}. Create it before writing this file.`;
      }
      return undefined;
    }
    if ((stat.stMode & S_IFMT) !== S_IFDIR) {
      return `Parent path is not a directory: ${parent}.`;
    }
    return undefined;
  }

  private async appendDiagnostics(
    safePath: string,
  ): Promise<{ notice: string; hasErrors: boolean }> {
    const result = await fetchDiagnostics(
      this.lspRegistry,
      this.jian,
      safePath,
      this.workspace.workspaceDir,
    );
    const notice = formatDiagnosticsNotice(result);
    const hint = formatDiagnosticsHint(result);
    return {
      notice: [notice, hint].filter((s) => s.length > 0).join(''),
      hasErrors: result.hasErrors,
    };
  }
}
