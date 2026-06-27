/**
 * EditTool — exact string replacement in a file.
 *
 * Replaces the first occurrence of `old_string` with `new_string` by
 * default. When `replace_all` is true, replaces all occurrences.
 * Errors when `old_string` is not found or not unique (when
 * `replace_all=false`). Path access policy is resolved before any
 * Jian I/O.
 */

import type { Jian } from '@scream-code/jian';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { LspRegistry } from '../../../lsp/registry';
import { resolvePathAccessPath } from '../../policies/path-access';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import { scanConflictLines } from './conflict-detect';
import { fetchDiagnostics, formatDiagnosticsHint, formatDiagnosticsNotice } from './lsp-diagnostics';
import { materializeModelText, toModelTextView, computeAnchor } from './line-endings';
import {
  hashEditPayload,
  NOOP_HARD_LIMIT,
  recordFailedEdit,
  resetNoopLoop,
} from './noop-loop-guard';
import EDIT_DESCRIPTION from './edit.md';

// `old_string` must be non-empty: the non-replace_all branch walks
// occurrences with `content.indexOf("", pos)`, which would loop forever
// on an empty search string.
export const EditInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute.',
    ),
  old_string: z
    .string()
    .min(1)
    .describe(
      'Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\r escapes where Read shows \\r.',
    ),
  new_string: z
    .string()
    .describe(
      'Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files.',
    ),
  replace_all: z
    .boolean()
    .optional()
    .describe('Set true only when every occurrence of old_string should be replaced.'),
  anchor: z
    .string()
    .optional()
    .describe(
      'Content anchor from the most recent Read of this file. When provided, Edit verifies the file content has not changed before applying the replacement.',
    ),
});

export type EditInput = z.Infer<typeof EditInputSchema>;

function replaceOnceLiteral(content: string, oldString: string, newString: string): string {
  const index = content.indexOf(oldString);
  if (index === -1) return content;
  return content.slice(0, index) + newString + content.slice(index + oldString.length);
}

export class EditTool implements BuiltinTool<EditInput> {
  readonly name = 'Edit' as const;
  readonly description = EDIT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EditInputSchema);

  constructor(
    private readonly jian: Jian,
    private readonly workspace: WorkspaceConfig,
    private readonly lspRegistry?: LspRegistry,
  ) {}

  resolveExecution(args: EditInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
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
      execute: () => this.execution(args, path),
    };
  }

  private async execution(args: EditInput, safePath: string): Promise<ExecutableToolResult> {
    const result = await this.executionCore(args, safePath);
    const inputHash = hashEditPayload({
      path: args.path,
      old_string: args.old_string,
      new_string: args.new_string,
      replace_all: args.replace_all,
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

  private async executionCore(args: EditInput, safePath: string): Promise<ExecutableToolResult> {
    if (args.old_string === args.new_string) {
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
      const replaceAll = args.replace_all ?? false;

      const existingBlocks = scanConflictLines(content.split('\n'));
      if (existingBlocks.length > 0) {
        const oldStringLineCount = args.old_string.split('\n').length;
        let pos = 0;
        let conflictViolation: string | null = null;
        while (pos < content.length) {
          const idx = content.indexOf(args.old_string, pos);
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
          pos = idx + args.old_string.length;
        }
        if (conflictViolation !== null) {
          return { isError: true, output: conflictViolation };
        }
      }

      if (args.anchor !== undefined) {
        const currentAnchor = computeAnchor(content);
        if (currentAnchor !== args.anchor) {
          return {
            isError: true,
            output: `File has changed since last read. The anchor no longer matches (expected ${args.anchor}, got ${currentAnchor}). Please re-read the file and retry.`,
          };
        }
      }

      if (!replaceAll) {
        let count = 0;
        let pos = 0;
        while (pos < content.length) {
          const idx = content.indexOf(args.old_string, pos);
          if (idx === -1) break;
          count++;
          pos = idx + args.old_string.length;
        }

        if (count === 0) {
          return { isError: true, output: `old_string not found in ${args.path}, The file contents may be out of date. Please use the Read Tool to reload the content.
` };
        }
        if (count > 1) {
          return {
            isError: true,
            output:
              `old_string is not unique in ${args.path} (found ${String(count)} occurrences). ` +
              'To replace every occurrence, set replace_all=true. To replace only one occurrence, include more surrounding context in old_string.',
          };
        }

        const newContent = replaceOnceLiteral(content, args.old_string, args.new_string);
        await this.jian.writeText(
          safePath,
          materializeModelText(newContent, modelView.lineEndingStyle),
        );
        const { notice, hasErrors } = await this.appendDiagnostics(safePath);
        const output = `Replaced 1 occurrence in ${args.path}${notice}`;
        return hasErrors ? { isError: true, output } : { output };
      }

      const parts = content.split(args.old_string);
      const replacementCount = parts.length - 1;
      if (replacementCount === 0) {
        return { isError: true, output: `old_string not found in ${args.path}, The file contents may be out of date. Please use the Read Tool to reload the content.
` };
      }

      const newContent = parts.join(args.new_string);
      await this.jian.writeText(
        safePath,
        materializeModelText(newContent, modelView.lineEndingStyle),
      );
      const { notice, hasErrors } = await this.appendDiagnostics(safePath);
      const output = `Replaced ${String(replacementCount)} occurrences in ${args.path}${notice}`;
      return hasErrors ? { isError: true, output } : { output };
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
