/**
 * WriteTool — overwrite or append to a file.
 *
 * Creates the file if it does not exist, and any missing parent directories.
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
import { countLines, fileDiffDetails } from '../../support/file-diff';
import type { EditRecoveryQueue } from '../../support/edit-recovery-queue';
import type { EditSnapshotStore } from '../../support/edit-snapshot-store';
import { renameArgAliases } from '../../support/arg-aliases';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import { withFileMutationLock } from './mutation-queue';
import { scanCache } from '../../support/scan-cache';
import type { WorkspaceConfig } from '../../support/workspace';
import { scanConflictLines } from './conflict-detect';
import { computeAnchor, toModelTextView } from './line-endings';
import {
  fetchDiagnostics,
  formatDiagnosticsHint,
  formatDiagnosticsNotice,
  reconcileEditReminders,
  type DiagnosticsResult,
} from './lsp-diagnostics';
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
      'Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created.',
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

/**
 * Spellings models use for this tool's arguments; renamed before validation
 * (`ExecutableTool.normalizeArgs`). Taken from calls that were rejected in practice.
 */
export const WRITE_ARG_ALIASES = { file_path: 'path' } as const;

export class WriteTool implements BuiltinTool<WriteInput> {
  readonly name = 'Write' as const;
  readonly description = WRITE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WriteInputSchema);

  normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    return renameArgAliases(args, WRITE_ARG_ALIASES);
  }

  constructor(
    private readonly jian: Jian,
    private readonly workspace: WorkspaceConfig,
    private readonly lspRegistry?: LspRegistry,
    /**
     * Session queue of post-edit error reminders; absent outside an Agent.
     * A Write can be the fix that resolves a pending reminder (the repair
     * often bypasses Edit), and its post-write diagnostics are the only
     * observation that path gets.
     */
    private readonly editRecovery?: EditRecoveryQueue,
    /**
     * Session snapshot store: what a Write leaves on disk is a view the model
     * produced itself, so a later Edit still carrying the anchor of an
     * earlier Read is recognised as working across its own change.
     */
    private readonly editSnapshots?: EditSnapshotStore,
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
      // Same-path mutations serialize (see mutation-queue): a batch or two
      // sub-agents can write one file concurrently, and the read-modify-write
      // step must not interleave.
      execute: ({ signal }) => withFileMutationLock(path, () => this.execution(args, path, signal)),
    };
  }

  private async execution(
    args: WriteInput,
    safePath: string,
    signal?: AbortSignal,
  ): Promise<ExecutableToolResult> {
    signal?.throwIfAborted();
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

    // Last, so a write that is refused above has no side effect: creating the
    // directories first left a refused write's empty tree on disk.
    const parent = await this.ensureParentDirectory(safePath);
    if (parent.error !== undefined) {
      return { isError: true, output: parent.error };
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
      this.rememberWrittenView(mode === 'append' ? (existing.kind === 'text' ? existing.text + args.content : undefined) : args.content, safePath);
      // Report the number of UTF-8 bytes this call wrote to disk. The string
      // length would only equal the byte count for pure ASCII content, so it
      // is not used here.
      const bytesWritten = Buffer.byteLength(args.content, 'utf8');
      const { notice, hint, result } = await this.appendDiagnostics(safePath);
      // A Write often IS the fix for a pending reminder. Fold the observation
      // into the queue before returning so the reminder stops re-appearing.
      await reconcileEditReminders(this.editRecovery, this.jian, safePath, result);
      // Diagnostics are appended to the (model-visible) output so the model
      // can self-correct in the same turn; the install hint travels on the
      // `message` side channel for the UI.
      // A created directory is reported so a mistyped path is visible to the
      // model instead of silently growing a new tree.
      const created = parent.created === undefined ? '' : `\nCreated directory ${parent.created}`;
      const base = `${mode === 'append' ? 'Appended' : 'Wrote'} ${String(bytesWritten)} bytes to ${args.path}${created}`;
      const output =
        notice.length > 0
          ? `${base}\n\nWrite applied; the language server reports:\n${notice}`
          : base;
      const message = hint.length > 0 ? hint : undefined;
      // A write that left errors still happened: a success the completion
      // check reads `leftErrors` from, not a failure.
      const leftErrors = result.hasErrors ? { leftErrors: true } : {};
      return display === undefined ? { output, message, ...leftErrors } : { output, message, display, ...leftErrors };
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
    return fileDiffDisplay(before, before + content, content);
  }

  /** Record what is now on disk as the model's own view (unknown append bases are skipped). */
  private rememberWrittenView(text: string | undefined, safePath: string): void {
    if (text === undefined || this.editSnapshots === undefined) return;
    const view = toModelTextView(text).text;
    this.editSnapshots.remember(safePath, { content: view, anchor: computeAnchor(view), recordedAt: 'edit' });
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
    if (existing.kind === 'unavailable') return undefined;
    return fileDiffDisplay(existing.kind === 'missing' ? '' : existing.text, content, content);
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
   * Make sure the parent directory exists and is a directory, creating it (and
   * any missing ancestors) when it is absent.
   *
   * Models routinely write a new file into a directory that does not exist yet;
   * refusing cost a whole extra step plus a shell `mkdir`. The write itself was
   * already authorized for this exact path, so creating its parents adds no
   * reach. Returns `created` when directories were made, `error` when the
   * precondition cannot be met (a non-directory in the way, a failed `mkdir`).
   * Any other `stat` failure (permissions, an environment without `stat`) is
   * inconclusive: nothing is created and the write proceeds, surfacing the real
   * I/O error if any.
   */
  private async ensureParentDirectory(
    safePath: string,
  ): Promise<{ readonly created?: string; readonly error?: string }> {
    const parent = dirname(safePath);
    let stat;
    try {
      stat = await this.jian.stat(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return {};
      try {
        await this.jian.mkdir(parent, { parents: true, existOk: true });
      } catch (mkdirError) {
        const reason = mkdirError instanceof Error ? mkdirError.message : String(mkdirError);
        return { error: `Could not create parent directory ${parent}: ${reason}` };
      }
      return { created: parent };
    }
    if ((stat.stMode & S_IFMT) !== S_IFDIR) {
      return { error: `Parent path is not a directory: ${parent}.` };
    }
    return {};
  }

  private async appendDiagnostics(
    safePath: string,
  ): Promise<{ notice: string; hint: string; result: DiagnosticsResult }> {
    const result = await fetchDiagnostics(
      this.lspRegistry,
      this.jian,
      safePath,
      this.workspace.workspaceDir,
    );
    // Diagnostics are model-facing (appended to the tool output); the install
    // hint is user-facing and travels on the `message` side channel so it
    // does not burn model tokens on every write. The raw result travels too:
    // the reminder reconciliation needs `observed`, not just the rendered text.
    return {
      notice: formatDiagnosticsNotice(result),
      hint: formatDiagnosticsHint(result),
      result,
    };
  }
}

/**
 * The `file_diff` display of a write: exact counts plus the first changed
 * lines. Replaced text is never carried (only `content` is the call's own),
 * so an overwrite's deletions keep their line numbers alone.
 */
function fileDiffDisplay(before: string, after: string, content: string): ToolResultDisplay | undefined {
  const details = fileDiffDetails(before, after, { deletedText: false, carried: content });
  // A new file too large to diff can only have gained lines: keep the count.
  if (details === undefined) return before === '' ? { kind: 'file_diff', added: countLines(after), removed: 0 } : undefined;
  return {
    kind: 'file_diff',
    added: details.added,
    removed: details.removed,
    preview: details.preview,
    previewTotal: details.previewTotal,
  };
}
