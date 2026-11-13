/**
 * EditTool — exact string or line-range replacement in a file.
 *
 * old_string mode (default): replaces the first occurrence of `old_string`
 * with `new_string`; when `replace_all` is true, replaces all occurrences.
 * Errors when `old_string` is not found or not unique (when
 * `replace_all=false`). replace_range mode: replaces the whole 1-indexed
 * line window [start_line, end_line] of the model view from the most recent
 * Read. Path access policy is resolved before any Jian I/O.
 */

import type { Jian } from '@scream-code/jian';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { WorkingSet } from '../../../agent/working-set';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { LspRegistry } from '../../../lsp/registry';
import type { ToolResultDisplay } from '../../display';
import { resolvePathAccessPath } from '../../policies/path-access';
import type { EditSnapshotStore } from '../../support/edit-snapshot-store';
import {
  EDIT_RECOVERY_INSTRUCTION,
  diagnosticsSignatures,
  type EditRecoveryQueue,
  type EditRecoverySignature,
} from '../../support/edit-recovery-queue';
import { fileDiffSummary } from '../../support/file-diff';
import { toInputJsonSchema } from '../../support/input-schema';
import {
  buildLineMapping,
  diffLineRuns,
  type LineDiffRun,
  physicalLinesOf,
} from '../../support/line-diff';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import { scanCache } from '../../support/scan-cache';
import { withFileMutationLock } from './mutation-queue';
import type { WorkspaceConfig } from '../../support/workspace';
import { scanConflictLines, type ConflictBlock } from './conflict-detect';
import { fetchDiagnostics, formatDiagnosticsHint, formatDiagnosticsNotice } from './lsp-diagnostics';
import {
  materializeModelText,
  toModelTextView,
  computeAnchor,
  type ModelTextView,
} from './line-endings';
import {
  hashEditPayload,
  NOOP_HARD_LIMIT,
  recordFailedEdit,
  resetNoopLoop,
} from './noop-loop-guard';
import EDIT_DESCRIPTION from './edit.md';

// `old_string` must be non-empty when present: the non-replace_all branch
// walks occurrences with `content.indexOf("", pos)`, which would loop forever
// on an empty search string.
//
// Two exclusive modes:
// - old_string mode (default): exact string replacement; `old_string` is
//   required and the line-range fields must be absent.
// - replace_range mode: `start_line` + `end_line` select a 1-indexed line
//   window against the model view of the most recent Read; `old_string` must
//   be absent, `anchor` is mandatory (line numbers are only meaningful
//   against that snapshot) and `replace_all` is rejected.
export const EditInputSchema = z
  .object({
    path: z
      .string()
      .describe(
        'Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute.',
      ),
    old_string: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\r escapes where Read shows \\r. Required in old_string mode; omit it when start_line/end_line select a line range.',
      ),
    new_string: z
      .string()
      .describe(
        'Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files. In replace_range mode it replaces the whole window; an empty string deletes it.',
      ),
    replace_all: z
      .boolean()
      .optional()
      .describe(
        'Set true only when every occurrence of old_string should be replaced. Not valid with start_line/end_line.',
      ),
    start_line: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'First line of the window to replace, 1-indexed against the model view of the most recent Read. Provide together with end_line and omit old_string.',
      ),
    end_line: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Last line of the window to replace (inclusive), against the same Read view; must not exceed the file line count reported there.',
      ),
    anchor: z
      .string()
      .optional()
      .describe(
        'Content anchor from the most recent Read of this file. When provided, Edit verifies the file content has not changed before applying the replacement. Required for line-range edits.',
      ),
  })
  .superRefine((args, ctx) => {
    if (args.start_line !== undefined && args.end_line !== undefined) {
      if (args.old_string !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['old_string'],
          message:
            'old_string must be omitted when start_line/end_line select a line range — the two modes are exclusive.',
        });
      }
      if (args.replace_all !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['replace_all'],
          message:
            'replace_all has no effect with start_line/end_line — a line range already selects exactly those lines. Omit it.',
        });
      }
      if (args.anchor === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['anchor'],
          message:
            'Line-range edits require the anchor from the most recent Read of this file — line numbers are only meaningful against that snapshot.',
        });
      }
      if (args.start_line > args.end_line) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['start_line'],
          message: `start_line (${String(args.start_line)}) must not exceed end_line (${String(args.end_line)}).`,
        });
      }
      return;
    }
    if (args.start_line !== undefined || args.end_line !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [args.start_line === undefined ? 'start_line' : 'end_line'],
        message: 'start_line and end_line must be provided together.',
      });
      return;
    }
    if (args.old_string === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['old_string'],
        message: 'old_string is required unless start_line and end_line select a line range.',
      });
    }
  });

export type EditInput = z.Infer<typeof EditInputSchema>;

function replaceOnceLiteral(content: string, oldString: string, newString: string): string {
  const index = content.indexOf(oldString);
  if (index === -1) return content;
  return content.slice(0, index) + newString + content.slice(index + oldString.length);
}

/**
 * Attach the exact `+added / -removed` line counts to a successful result so
 * the UI can total them per activity group.
 *
 * The counts come from the real pre-edit and post-edit text, so a
 * `replace_all` edit reports the whole-file delta instead of one occurrence's
 * worth. Error results carry no display: nothing was applied, or the failure
 * path never established the post-edit text.
 */
function withFileDiffDisplay(
  result: ExecutableToolResult,
  before: string,
  after: string,
): ExecutableToolResult {
  if (result.isError === true) return result;
  const summary = fileDiffSummary(before, after);
  if (summary === undefined) return result;
  const display: ToolResultDisplay = {
    kind: 'file_diff',
    added: summary.added,
    removed: summary.removed,
  };
  return { ...result, display };
}

/**
 * Join the edit result's base line, an optional stale-read warning, and the
 * language-server notice into the final (model-visible) output. Sections are
 * blank-line separated; empty sections are omitted. An optional recovery note
 * (stale-anchor remap) travels last so it is read after the diff counts.
 */
function assembleEditOutput(
  base: string,
  warning: string | undefined,
  notice: string,
  recoveryNote?: string,
): string {
  const sections = [base];
  if (warning !== undefined) sections.push(warning);
  if (notice.length > 0) sections.push(`Edit applied; the language server reports:\n${notice}`);
  if (recoveryNote !== undefined) sections.push(recoveryNote);
  return sections.join('\n\n');
}

/**
 * The pre-recovery anchor-mismatch reject, kept byte-identical everywhere it
 * is returned: with no usable snapshot (or outside replace_range mode) the
 * stale-anchor behaviour must be exactly what it was before recovery existed.
 */
function anchorMismatchError(anchor: string, currentAnchor: string): ExecutableToolResult {
  return {
    isError: true,
    output:
      `File has changed since last read. The anchor no longer matches ` +
      `(expected ${anchor}, got ${currentAnchor}). Please re-read the file and retry.`,
  };
}

/**
 * Conflict-overlap policy for a line window against a file's conflict
 * blocks: a window strictly inside a block is refused, while a range
 * covering the block's markers resolves the conflict and is allowed.
 * Returns the refusal result, or undefined when the window is writable.
 *
 * Usable on arbitrary (start, end) coordinates: the stale-anchor recovery
 * path re-runs it inside replaceRange with the remapped window, because the
 * executionCore pre-check can only compare the model's numbers against the
 * blocks of the content it just read — which are stale whenever the anchor
 * mismatches (see the deferral there).
 */
function rangeConflictRefusal(
  path: string,
  startLine: number,
  endLine: number,
  blocks: readonly ConflictBlock[],
  note = '',
): ExecutableToolResult | undefined {
  const insideBlocks = blocks.filter((b) => startLine > b.startLine && endLine < b.endLine);
  if (insideBlocks.length === 0) return undefined;
  const blockList = insideBlocks
    .map((b) => `lines ${String(b.startLine)}-${String(b.endLine)}`)
    .join(', ');
  return {
    isError: true,
    output:
      `lines ${String(startLine)}-${String(endLine)} of ${path} fall inside ` +
      `unresolved merge conflict markers (${blockList})${note}. ` +
      'Resolve the conflict before editing inside it, or widen the range to cover the entire block including its markers.',
  };
}

/**
 * Bookkeeping a stale-anchor recovery carries into the range apply: the
 * model's original window (for the remap note), the severity-1 diagnostic
 * count measured before the apply (rollback gate), and the exact on-disk text
 * to restore if the apply is rolled back. `preApplyErrorCount` is undefined
 * when no baseline was measurable (no active language client): without a
 * baseline there is nothing to compare against, so the rollback gate is
 * skipped rather than treating the file as error-free.
 */
interface RecoveryContext {
  readonly originalStartLine: number;
  readonly originalEndLine: number;
  readonly preApplyErrorCount: number | undefined;
  readonly preApplyText: string;
}

export class EditTool implements BuiltinTool<EditInput> {
  readonly name = 'Edit' as const;
  readonly description = EDIT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EditInputSchema);

  /**
   * Last diagnostics observation per file (canonical path → signature set).
   * Diffing each new observation against it is what separates errors this
   * edit introduced from errors the file already had.
   */
  private readonly diagnosticsSeen = new Map<string, Set<string>>();

  constructor(
    private readonly jian: Jian,
    private readonly workspace: WorkspaceConfig,
    private readonly lspRegistry?: LspRegistry,
    private readonly workingSet?: WorkingSet,
    /** Session snapshot store behind stale-anchor recovery; absent outside an Agent. */
    private readonly editSnapshots?: EditSnapshotStore,
    /**
     * Session queue of post-edit error reminders, rendered back into the
     * prompt by EditRecoveryInjector; absent outside an Agent.
     */
    private readonly editRecovery?: EditRecoveryQueue,
  ) {}

  async resolveExecution(args: EditInput): Promise<ToolExecution> {
    const path = await resolvePathAccessPath(args.path, {
      jian: this.jian,
      workspace: this.workspace,
      operation: 'write',
    });
    return {
      accesses: ToolAccesses.readWriteFile(path),
      description: `Editing ${args.path}`,
      display: {
        kind: 'file_io',
        operation: 'edit',
        path,
        before: args.old_string,
        after: args.new_string,
      },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: this.jian.pathClass(),
          homeDir: this.jian.gethome(),
        }),
      // Same-path mutations serialize (see mutation-queue). The noop-loop
      // bookkeeping inside `execution` runs under the lock too, so concurrent
      // attempts cannot interleave their failure counters.
      execute: ({ signal }) => withFileMutationLock(path, () => this.execution(args, path, signal)),
    };
  }

  private async execution(
    args: EditInput,
    safePath: string,
    signal?: AbortSignal,
  ): Promise<ExecutableToolResult> {
    signal?.throwIfAborted();
    const result = await this.executionCore(args, safePath, signal);
    const inputHash = hashEditPayload({
      path: args.path,
      old_string: args.old_string,
      new_string: args.new_string,
      replace_all: args.replace_all,
      start_line: args.start_line,
      end_line: args.end_line,
      anchor: args.anchor,
    });

    if (result.isError !== true) {
      resetNoopLoop(safePath);
      return result;
    }

    const { count, escalate } = recordFailedEdit(safePath, inputHash);
    if (escalate) {
      return {
        isError: true,
        stopTurn: true,
        output:
          `Edit to ${args.path} has failed ${String(NOOP_HARD_LIMIT)} times in a row with the ` +
          `same payload. The model appears stuck in a loop. Turn stopped. Re-read ${args.path} ` +
          `with the Read tool to observe current content, then issue a different edit.`,
      };
    }
    if (count >= 2) {
      return {
        ...result,
        output:
          (typeof result.output === 'string' ? result.output : '') +
          `\n\nWarning: attempt ${String(count)} of ${String(NOOP_HARD_LIMIT)} with the same ` +
          `payload on ${args.path}. The file may have changed — re-read it before retrying. ` +
          `One more identical failure will stop the turn.`,
      };
    }
    return result;
  }

  private async executionCore(
    args: EditInput,
    safePath: string,
    signal?: AbortSignal,
  ): Promise<ExecutableToolResult> {
    const startLine = args.start_line;
    const endLine = args.end_line;
    const oldString = args.old_string;

    // Mode guards. The schema refinements enforce the same rules for
    // model-driven calls; these keep direct callers that bypass schema
    // validation equally loud instead of silently degrading to old_string
    // mode. (Runtime args are Ajv-validated against the JSON schema, which
    // carries no cross-field rules, so this is the real enforcement point.)
    if (startLine !== undefined && endLine !== undefined) {
      if (oldString !== undefined) {
        return {
          isError: true,
          output:
            'old_string must be omitted when start_line/end_line select a line range — the two modes are exclusive.',
        };
      }
      if (args.replace_all !== undefined) {
        return {
          isError: true,
          output:
            'replace_all has no effect with start_line/end_line — a line range already selects exactly those lines. Omit it.',
        };
      }
      if (args.anchor === undefined) {
        return {
          isError: true,
          output:
            'Line-range edits require the anchor from the most recent Read of this file — line numbers are only meaningful against that snapshot.',
        };
      }
      if (startLine > endLine) {
        return {
          isError: true,
          output: `start_line (${String(startLine)}) must not exceed end_line (${String(endLine)}).`,
        };
      }
    } else if (startLine !== undefined || endLine !== undefined) {
      return {
        isError: true,
        output: 'start_line and end_line must be provided together.',
      };
    }

    if (oldString !== undefined && oldString === args.new_string) {
      return {
        isError: true,
        output: 'No changes to make: old_string and new_string are exactly the same.',
      };
    }

    const newStringBlocks = scanConflictLines(args.new_string.split('\n'));
    if (newStringBlocks.length > 0) {
      return {
        isError: true,
        output:
          'new_string contains merge conflict markers (<<<<<<< / ======= / >>>>>>>). ' +
          'Remove them before writing. These markers indicate an unresolved merge and should not be introduced into files.',
      };
    }

    try {
      const raw = await this.jian.readText(safePath);
      const modelView = toModelTextView(raw);
      const content = modelView.text;
      // Seed the reminder baseline from a PRE-write observation. Without a
      // baseline the post-write track cannot tell an error this edit
      // introduced from one the file already had, so the first edit of a file
      // would never queue a reminder. Bounded: only when the file has no
      // baseline yet and a language client is already active (this never
      // cold-starts a server); a timeout or an unavailable server leaves the
      // baseline unset, keeping the conservative "record only" behaviour.
      await this.seedDiagnosticsBaseline(safePath, signal);
      const replaceAll = args.replace_all ?? false;
      const currentAnchor = computeAnchor(content);
      // Range mode always carries an anchor (the mode guards above return
      // earlier without one); a mismatch means its line numbers are stale
      // and recovery will remap them.
      const anchorStale = args.anchor !== undefined && currentAnchor !== args.anchor;

      const existingBlocks = scanConflictLines(content.split('\n'));
      if (existingBlocks.length > 0) {
        if (startLine !== undefined && endLine !== undefined) {
          // replace_range: same policy as old_string mode — a window strictly
          // inside a block is refused, while a range covering the block's
          // markers resolves the conflict and is allowed.
          //
          // Authoritative only for current coordinates: with a stale anchor
          // the numbers describe the model's last Read, so the overlap they
          // show can be an artifact of the external change (a block that
          // moved across the stale numbers). That path defers to the
          // re-check on the remapped window inside replaceRange — a
          // stale-coordinate refusal here could only false-reject a recovery
          // that would write cleanly.
          if (!anchorStale) {
            const refusal = rangeConflictRefusal(args.path, startLine, endLine, existingBlocks);
            if (refusal !== undefined) return refusal;
          }
        } else if (oldString !== undefined) {
          const oldStringLineCount = oldString.split('\n').length;
          let pos = 0;
          let conflictViolation: string | null = null;
          while (pos < content.length) {
            const idx = content.indexOf(oldString, pos);
            if (idx === -1) break;
            const matchStartLine = content.slice(0, idx).split('\n').length;
            const matchEndLine = matchStartLine + oldStringLineCount - 1;
            const insideBlock = existingBlocks.some(
              (b) => matchStartLine > b.startLine && matchEndLine < b.endLine,
            );
            if (insideBlock) {
              const blockList = existingBlocks
                .map((b) => `lines ${String(b.startLine)}-${String(b.endLine)}`)
                .join(', ');
              conflictViolation =
                `${args.path} has unresolved merge conflict markers (${blockList}). ` +
                'Resolve the conflict before editing inside it, or include the conflict markers in old_string to replace them.';
              break;
            }
            pos = idx + oldString.length;
          }
          if (conflictViolation !== null) {
            return { isError: true, output: conflictViolation };
          }
        }
      }

      if (args.anchor !== undefined) {
        if (currentAnchor !== args.anchor) {
          // replace_range gets one recovery attempt: the snapshot store may
          // still hold the view the model's line numbers refer to, and a
          // window can be remapped across an external change. old_string mode
          // stays a hard reject — an exact-match replace has no meaningful
          // remap.
          if (startLine !== undefined && endLine !== undefined) {
            return await this.attemptStaleAnchorRecovery(
              args,
              startLine,
              endLine,
              content,
              modelView,
              raw,
              safePath,
            );
          }
          return anchorMismatchError(args.anchor, currentAnchor);
        }
      }

      if (startLine !== undefined && endLine !== undefined) {
        return await this.replaceRange(args, startLine, endLine, content, modelView, raw, safePath);
      }

      if (oldString === undefined) {
        // Schema-validated calls can no longer get here (the mode guards
        // above cover both modes); kept for direct callers so the match
        // logic below can assume a non-empty search string.
        return {
          isError: true,
          output: 'old_string is required unless start_line and end_line select a line range.',
        };
      }

      if (!replaceAll) {
        let count = 0;
        let pos = 0;
        const matchLineNumbers: number[] = [];
        while (pos < content.length) {
          const idx = content.indexOf(oldString, pos);
          if (idx === -1) break;
          count++;
          if (matchLineNumbers.length < 10) {
            const lineNum = content.slice(0, idx).split('\n').length;
            matchLineNumbers.push(lineNum);
          }
          pos = idx + oldString.length;
        }

        if (count === 0) {
          const lineCount = content.split('\n').length;
          return {
            isError: true,
            output:
              `old_string not found in ${args.path} (file has ${String(lineCount)} lines). ` +
              'The file contents may be out of date — re-read with the Read tool. ' +
              'If you already re-read, verify old_string matches exactly: indentation, trailing whitespace, and line endings (LF vs CRLF) must all match the Read output view.',
          };
        }
        if (count > 1) {
          const truncatedNote =
            count > matchLineNumbers.length ? ` (showing first ${String(matchLineNumbers.length)})` : '';
          return {
            isError: true,
            output:
              `old_string is not unique in ${args.path} (found ${String(count)} occurrences at lines: ${matchLineNumbers.join(', ')}${truncatedNote}). ` +
              'To replace every occurrence, set replace_all=true. ' +
              'To target a specific one, include more surrounding context lines from one of those line ranges in old_string.',
          };
        }

        const newContent = replaceOnceLiteral(content, oldString, args.new_string);
        // The text actually written to disk, in the file's own line-ending
        // style — the diff below is measured against this, not the model view.
        const writtenText = materializeModelText(newContent, modelView.lineEndingStyle);
        await this.jian.writeText(safePath, writtenText);
        scanCache.clear();
        this.rememberPostEditSnapshot(safePath, newContent);
        const { notice, hint, hasErrors, signatures } = await this.appendDiagnostics(safePath);
        this.trackEditDiagnostics(safePath, args.path, signatures);
        // Diagnostics are appended to the (model-visible) output so the model
        // can self-correct in the same turn; the install hint travels on the
        // `message` side channel for the UI. `hasErrors` keeps isError so the
        // fix-then-re-verify gate still picks the edit up.
        const output = assembleEditOutput(
          `Replaced 1 occurrence in ${args.path}`,
          this.staleReadWarning(args, safePath),
          notice,
        );
        const message = hint.length > 0 ? hint : undefined;
        const result: ExecutableToolResult = hasErrors
          ? { isError: true, output, message }
          : { output, message };
        return withFileDiffDisplay(result, raw, writtenText);
      }

      const parts = content.split(oldString);
      const replacementCount = parts.length - 1;
      if (replacementCount === 0) {
        const lineCount = content.split('\n').length;
        return {
          isError: true,
          output:
            `old_string not found in ${args.path} (file has ${String(lineCount)} lines). ` +
            'The file contents may be out of date — re-read with the Read tool. ' +
            'If you already re-read, verify old_string matches exactly: indentation, trailing whitespace, and line endings (LF vs CRLF) must all match the Read output view.',
        };
      }

      const newContent = parts.join(args.new_string);
      // Diff the whole file around the write: `replace_all` reports the real
      // delta for every occurrence, not one occurrence multiplied out.
      const writtenText = materializeModelText(newContent, modelView.lineEndingStyle);
      await this.jian.writeText(safePath, writtenText);
      scanCache.clear();
      this.rememberPostEditSnapshot(safePath, newContent);
      const { notice, hint, hasErrors, signatures } = await this.appendDiagnostics(safePath);
      this.trackEditDiagnostics(safePath, args.path, signatures);
      // Diagnostics are appended to the (model-visible) output so the model
      // can self-correct in the same turn; the install hint travels on the
      // `message` side channel for the UI. `hasErrors` keeps isError so the
      // fix-then-re-verify gate still picks the edit up.
      const output = assembleEditOutput(
        `Replaced ${String(replacementCount)} occurrences in ${args.path}`,
        this.staleReadWarning(args, safePath),
        notice,
      );
      const message = hint.length > 0 ? hint : undefined;
      const result: ExecutableToolResult = hasErrors
        ? { isError: true, output, message }
        : { output, message };
      return withFileDiffDisplay(result, raw, writtenText);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'EISDIR') {
        return { isError: true, output: `${args.path} is not a file.` };
      }
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Stale-anchor recovery for replace_range. The anchor mismatch says the
   * file changed since the model's read; the snapshot store may still hold
   * the view the model's line numbers refer to. Diffing snapshot against
   * current maps the window into current coordinates when the external
   * change did not land inside it, and refuses loudly when it did. Every
   * refusal returns an isError result, so the noop-loop accounting in
   * `execution` treats a refused recovery like any other failed attempt.
   */
  private async attemptStaleAnchorRecovery(
    args: EditInput,
    startLine: number,
    endLine: number,
    content: string,
    modelView: ModelTextView,
    raw: string,
    safePath: string,
  ): Promise<ExecutableToolResult> {
    const hardReject = (): ExecutableToolResult =>
      anchorMismatchError(args.anchor ?? '', computeAnchor(content));

    const snapshot = this.editSnapshots?.recall(safePath);
    if (snapshot === undefined) return hardReject();
    // The model's line numbers describe the view its anchor was computed
    // from. A snapshot from a different view (e.g. our own post-edit record
    // when the model skipped re-reading) cannot remap them.
    if (snapshot.anchor !== args.anchor) return hardReject();
    // Identical content would have matched the anchor above, so reaching this
    // point with equal texts is a data anomaly — refuse rather than remap
    // against untrusted state.
    if (snapshot.content === content) return hardReject();

    const snapshotLines = physicalLinesOf(snapshot.content);
    const currentLines = physicalLinesOf(content);
    const runs = diffLineRuns(snapshotLines, currentLines);
    // Over the diff size cap: no trustworthy remap, fall back to the reject.
    if (runs === null) return hardReject();
    const mapping = buildLineMapping(runs, snapshotLines.length, currentLines.length);

    // The window must refer to lines the model actually read.
    if (startLine > snapshotLines.length || endLine > snapshotLines.length) {
      return {
        isError: true,
        output:
          `Cannot remap line range ${String(startLine)}-${String(endLine)}: the snapshot behind ` +
          `this anchor recorded ${String(snapshotLines.length)} lines ` +
          `(the current file has ${String(currentLines.length)}). ` +
          'Re-read the file and re-anchor before retrying.',
      };
    }

    const guardAError = (externalEdit: string): ExecutableToolResult => ({
      isError: true,
      output:
        `The file changed externally in the region you are targeting (your lines ` +
        `${String(startLine)}-${String(endLine)} shifted by the external edit ${externalEdit}). ` +
        'Re-read the file and re-anchor before retrying.',
    });

    const mappedStart = mapping.mapSnapshotLine(startLine);
    const mappedEnd = mapping.mapSnapshotLine(endLine);
    // An endpoint without an image sits inside a delete run: the external
    // change removed a line the model aims at.
    if (mappedStart === undefined || mappedEnd === undefined) {
      const endpoint = mappedStart === undefined ? startLine : endLine;
      const run = runs.find(
        (candidate): candidate is LineDiffRun =>
          candidate.type === 'delete' && endpoint >= candidate.snapStart && endpoint <= candidate.snapEnd,
      );
      return guardAError(
        run === undefined
          ? 'at an unknown snapshot line'
          : `at snapshot lines ${String(run.snapStart)}-${String(run.snapEnd)}`,
      );
    }

    const conflict = mapping.firstConflictingRun(startLine, endLine, mappedStart, mappedEnd);
    if (conflict !== undefined) {
      return guardAError(
        conflict.type === 'delete'
          ? `at snapshot lines ${String(conflict.snapStart)}-${String(conflict.snapEnd)}`
          : `after snapshot line ${String(conflict.snapStart - 1)}`,
      );
    }

    // Defensive: the mapping cannot produce these with clean endpoints, but an
    // invalid window must never reach the writer.
    if (mappedStart > mappedEnd || mappedEnd > currentLines.length) {
      return {
        isError: true,
        output:
          `Cannot remap line range ${String(startLine)}-${String(endLine)}: the remapped window ` +
          `is invalid in the current file of ${String(currentLines.length)} lines. ` +
          'Re-read the file and re-anchor before retrying.',
      };
    }

    // Rollback baseline: with an active language server, count the severity-1
    // diagnostics the externally changed file already reports, so the
    // post-apply count can be compared against it. No active client (this
    // never cold-starts one) → leave the baseline undefined, which skips the
    // rollback gate entirely (an unmeasured baseline must not read as zero).
    let preApplyErrorCount: number | undefined;
    if (this.lspRegistry !== undefined) {
      const client = await this.lspRegistry.activeClientFor(safePath, this.workspace.workspaceDir);
      if (client !== undefined) {
        const pre = await fetchDiagnostics(
          this.lspRegistry,
          this.jian,
          safePath,
          this.workspace.workspaceDir,
        );
        preApplyErrorCount = pre.observed
          ? pre.diagnostics.filter((d) => d.severity === 1).length
          : undefined;
      }
    }

    return this.replaceRange(
      args,
      mappedStart,
      mappedEnd,
      content,
      modelView,
      raw,
      safePath,
      {
        originalStartLine: startLine,
        originalEndLine: endLine,
        preApplyErrorCount,
        preApplyText: raw,
      },
    );
  }

  /**
   * replace_range: swap the 1-indexed line window [startLine, endLine] of the
   * Read model view for `new_string`'s lines. Line numbers have already been
   * pinned to this exact content by the anchor check; the bounds check here
   * only catches windows past the end of the file, which signals stale
   * numbers rather than a legitimate window.
   *
   * The replacement is assembled from physical lines the way Read counts
   * them (a trailing newline terminates the last line instead of opening an
   * empty one, an empty file has zero lines) and materialized with the
   * file's own line-ending style, so CRLF files keep CRLF and the file's
   * trailing-newline convention is preserved.
   *
   * With `recovery` set this is a stale-anchor recovery apply: the window is
   * already remapped into current coordinates, new language-server errors
   * after the write roll the file back to its pre-apply text, and the result
   * carries the remap note next to the usual sections.
   */
  private async replaceRange(
    args: EditInput,
    startLine: number,
    endLine: number,
    content: string,
    modelView: ModelTextView,
    raw: string,
    safePath: string,
    recovery?: RecoveryContext,
  ): Promise<ExecutableToolResult> {
    const endsWithNewline = content.endsWith('\n');
    const physicalLines = physicalLinesOf(content);
    const totalLines = physicalLines.length;

    if (endLine > totalLines) {
      return {
        isError: true,
        output:
          `Cannot replace lines ${String(startLine)}-${String(endLine)}: ` +
          `file has ${String(totalLines)} lines; requested lines ${String(startLine)}-${String(endLine)} exceed it. ` +
          'Line numbers refer to the most recent Read view — re-read the file and retry with a fresh range.',
      };
    }

    // Recovery applies remap the model's stale line numbers into current
    // coordinates, and the conflict pre-check in executionCore deliberately
    // skipped its stale-coordinate check for this path — so this is the
    // authoritative overlap check: it runs the FINAL window (the one this
    // write actually touches) against the current content's conflict blocks.
    // The double check exists because the two never see the same
    // coordinates — the pre-check compares the model's numbers against this
    // content, this one compares the numbers actually written. A
    // stale-window overlap must not veto a remapped write that lands clean,
    // and a remapped window that lands strictly inside a moved block must
    // never write between the markers.
    if (recovery !== undefined) {
      const remappedRefusal = rangeConflictRefusal(
        args.path,
        startLine,
        endLine,
        scanConflictLines(content.split('\n')),
        ` after the remap of your lines ${String(recovery.originalStartLine)}-${String(recovery.originalEndLine)}`,
      );
      if (remappedRefusal !== undefined) return remappedRefusal;
    }

    const head = physicalLines.slice(0, startLine - 1);
    const tail = physicalLines.slice(endLine);
    const newLines = args.new_string.length === 0 ? [] : args.new_string.split('\n');
    const nextLines = [...head, ...newLines, ...tail];
    const newContent =
      nextLines.length === 0 ? '' : nextLines.join('\n') + (endsWithNewline ? '\n' : '');
    // The text actually written to disk, in the file's own line-ending
    // style — the diff below is measured against this, not the model view.
    const writtenText = materializeModelText(newContent, modelView.lineEndingStyle);
    await this.jian.writeText(safePath, writtenText);
    scanCache.clear();
    const { notice, hint, hasErrors, errorCount, signatures } =
      await this.appendDiagnostics(safePath);

    if (
      recovery !== undefined &&
      recovery.preApplyErrorCount !== undefined &&
      errorCount > recovery.preApplyErrorCount
    ) {
      // The remapped apply made things worse by the language server's
      // measure. Roll back to the pre-apply on-disk text — the externally
      // changed content, NOT the snapshot's: the external change is not ours
      // to discard, only this failed recovery apply is. Runs under the same
      // mutation lock as the apply itself (execution wraps both).
      //
      // This gate is best-effort by construction: diagnostics() polls for at
      // most ~1.5s after the write (the fetchDiagnostics timeout, polled in
      // 100ms ticks inside the client), so a late-publishing server can miss
      // a real regression here (kept silently), and a stale pre-apply
      // publication can trigger a false rollback — benign, since the restore
      // writes back the exact pre-apply text and tells the model to re-read.
      // Without an active client no baseline is measurable and the gate is
      // skipped entirely (see the RecoveryContext contract above).
      await this.jian.writeText(safePath, recovery.preApplyText);
      scanCache.clear();
      const introduced = errorCount - recovery.preApplyErrorCount;
      return {
        isError: true,
        output:
          `Recovery applied but introduced ${String(introduced)} new error(s) reported by the ` +
          'language server; the edit was rolled back. Re-read the file and re-anchor.',
      };
    }

    // Snapshot the post-apply state so a later stale-anchor attempt (or a
    // fresh read) works from what we actually wrote. Applied even when the
    // diagnostics gate flags hasErrors: the write already happened, and the
    // snapshot's job is to mirror the file we just produced.
    this.rememberPostEditSnapshot(safePath, newContent);
    // Only now: a rolled-back apply (above) must not fold its diagnostics into
    // the reminder state — they describe text that is no longer on disk.
    this.trackEditDiagnostics(safePath, args.path, signatures);

    const recoveryNote =
      recovery === undefined
        ? undefined
        : `Note: the file changed externally since your read; your line range was remapped ` +
          `(snapshot lines ${String(recovery.originalStartLine)}-${String(recovery.originalEndLine)} → ` +
          `current lines ${String(startLine)}-${String(endLine)}). Verify the result before continuing.`;

    // Diagnostics are appended to the (model-visible) output so the model
    // can self-correct in the same turn; the install hint travels on the
    // `message` side channel for the UI. `hasErrors` keeps isError so the
    // fix-then-re-verify gate still picks the edit up.
    const output = assembleEditOutput(
      startLine === endLine
        ? `Replaced line ${String(startLine)} in ${args.path}`
        : `Replaced lines ${String(startLine)}-${String(endLine)} in ${args.path}`,
      this.staleReadWarning(args, safePath),
      notice,
      recoveryNote,
    );
    const message = hint.length > 0 ? hint : undefined;
    const result: ExecutableToolResult = hasErrors
      ? { isError: true, output, message }
      : { output, message };
    return withFileDiffDisplay(result, raw, writtenText);
  }

  /**
   * Warn (model-visible) when this edit targets a file that was not read in
   * the recent history and no content anchor was supplied: the model may be
   * working from stale memory (e.g. after compaction). The warning never
   * blocks the edit.
   */
  private staleReadWarning(args: EditInput, safePath: string): string | undefined {
    if (args.anchor !== undefined) return undefined;
    if (this.workingSet === undefined) return undefined;
    if (this.workingSet.lastReadTurn(args.path) !== undefined) return undefined;
    if (this.workingSet.lastReadTurn(safePath) !== undefined) return undefined;
    return (
      `Note: no recent read of ${args.path} was found in this session; if you ` +
      `are editing from memory, consider reading it with the Read tool first.`
    );
  }

  private async appendDiagnostics(
    safePath: string,
  ): Promise<{
    notice: string;
    hint: string;
    hasErrors: boolean;
    errorCount: number;
    /**
     * Signatures of the errors this observation reported, or undefined when
     * the language server was unavailable (no registry, unsupported file
     * type, server missing, or the fetch timed out without a publication).
     * An unavailable or unobserved fetch is not an observation: it must
     * neither introduce nor resolve a reminder.
     */
    signatures: readonly EditRecoverySignature[] | undefined;
  }> {
    const result = await fetchDiagnostics(
      this.lspRegistry,
      this.jian,
      safePath,
      this.workspace.workspaceDir,
    );
    // Diagnostics are model-facing (appended to the tool output); the install
    // hint is user-facing and travels on the `message` side channel so it
    // does not burn model tokens on every edit. `errorCount` (severity-1
    // only) feeds the stale-anchor recovery rollback gate; `signatures` feeds
    // the session reminder queue.
    return {
      notice: formatDiagnosticsNotice(result),
      hint: formatDiagnosticsHint(result),
      hasErrors: result.hasErrors,
      errorCount: result.diagnostics.filter((d) => d.severity === 1).length,
      signatures:
        result.available && result.observed
          ? diagnosticsSignatures(result.diagnostics)
          : undefined,
    };
  }

  /**
   * Record a pre-write diagnostics observation as the file's baseline when it
   * has none yet.
   *
   * The first edit of a file used to record only (no baseline, so every error
   * looked pre-existing) — which meant a single-edit fix never queued its
   * reminder. Observing once before the write supplies that baseline, so the
   * post-write diff can name the errors this edit introduced.
   *
   * Silent and bounded by construction: no queue or registry returns
   * immediately, an already-seeded baseline is not re-fetched, and an
   * unobserved result (timeout, unavailable server, aborted turn) leaves the
   * baseline unset instead of guessing it. No activeClientFor gate: the
   * post-write fetch below starts the same language server anyway, so
   * requiring an already-running one would make the first edit of a session
   * unreachable — the exact case this seeding exists for.
   */
  private async seedDiagnosticsBaseline(
    safePath: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (this.editRecovery === undefined || this.lspRegistry === undefined) return;
    if (this.diagnosticsSeen.has(safePath)) return;
    if (signal?.aborted === true) return;
    let pre;
    try {
      pre = await fetchDiagnostics(
        this.lspRegistry,
        this.jian,
        safePath,
        this.workspace.workspaceDir,
      );
    } catch {
      return;
    }
    if (!pre.observed) return;
    this.diagnosticsSeen.set(
      safePath,
      new Set(diagnosticsSignatures(pre.diagnostics).map((signature) => signature.signature)),
    );
  }

  /**
   * Fold one post-apply diagnostics observation into the session reminder
   * state.
   *
   * The difference against the file's last-seen set is what this edit
   * introduced; the previous set is then replaced by the current one (always,
   * so a later edit is diffed against what the file looked like after this
   * one). The queue's resolution check runs on every observation, so a
   * reminder clears as soon as some later edit's diagnostics no longer list
   * its signatures.
   *
   * A file whose baseline was never observed (no active client at any point)
   * only records here: with no baseline every error would look introduced, and
   * files routinely carry pre-existing errors.
   */
  private trackEditDiagnostics(
    safePath: string,
    displayPath: string,
    signatures: readonly EditRecoverySignature[] | undefined,
  ): void {
    const queue = this.editRecovery;
    if (queue === undefined || signatures === undefined) return;
    const current = new Set(signatures.map((signature) => signature.signature));
    const previous = this.diagnosticsSeen.get(safePath);
    this.diagnosticsSeen.set(safePath, current);
    queue.clearIfResolved(safePath, current);
    if (previous === undefined) return;
    const introduced = signatures.filter((signature) => !previous.has(signature.signature));
    if (introduced.length === 0) return;
    queue.enqueue({
      path: safePath,
      displayPath,
      signatures: introduced,
      instruction: EDIT_RECOVERY_INSTRUCTION,
    });
  }

  /**
   * Record the post-apply snapshot for stale-anchor recovery of later edits:
   * the model view we just wrote, hashed to the anchor that view carries.
   */
  private rememberPostEditSnapshot(safePath: string, newContent: string): void {
    this.editSnapshots?.remember(safePath, {
      content: newContent,
      anchor: computeAnchor(newContent),
      recordedAt: 'edit',
    });
  }
}
