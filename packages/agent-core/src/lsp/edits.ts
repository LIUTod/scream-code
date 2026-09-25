/**
 * WorkspaceEdit application.
 *
 * Applies LSP rename refactors to files on disk via Jian I/O. MVP scope:
 * only `changes` (legacy map) and `documentChanges` entries of type
 * `TextDocumentEdit`. CreateFile / RenameFile / DeleteFile resource
 * operations are ignored — scream-code's LSP tool is read-only by policy
 * and rename is the only write op.
 *
 * Security: every path the LSP returns is validated via `validatePath`
 * before any read or write. A misbehaving server (or a symlink that
 * resolves outside the workspace) cannot trick us into writing outside
 * the workspace root.
 */

import type { Jian } from '@scream-code/jian';

import type { LspTextEdit, LspWorkspaceEdit } from './client';
import { uriToPath } from './client';

export interface AppliedEdit {
  readonly filePath: string;
  readonly editCount: number;
}

/**
 * Thrown when the LSP returns edits targeting a file outside the workspace.
 * Caught by the tool layer and surfaced as an error result rather than
 * silently writing outside the workspace.
 */
export class LspEditPathValidationError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`LSP rename targets a file outside the workspace: ${path}`);
    this.name = 'LspEditPathValidationError';
    this.path = path;
  }
}

function comparePosition(
  a: { line: number; character: number },
  b: { line: number; character: number },
): number {
  return a.line === b.line ? a.character - b.character : a.line - b.line;
}

/**
 * Sort edits bottom-to-top for in-place application and reject overlaps.
 * Equal start positions tiebreak by original array index descending so that,
 * applied bottom-up, inserts at the same position land in array order
 * (LSP spec: the order of edits in the array defines the order in the result).
 */
function sortAndValidateTextEdits(edits: readonly LspTextEdit[]): LspTextEdit[] {
  const sorted = edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => {
      const sa = a.edit.range.start;
      const sb = b.edit.range.start;
      if (sa.line !== sb.line) return sb.line - sa.line;
      if (sa.character !== sb.character) return sb.character - sa.character;
      return b.index - a.index;
    })
    .map((entry) => entry.edit);

  for (let i = 0; i < sorted.length - 1; i++) {
    const later = sorted[i]!.range;
    const earlier = sorted[i + 1]!.range;
    if (comparePosition(earlier.end, later.start) > 0) {
      throw new Error(
        `overlapping LSP edits at ${earlier.start.line + 1}:${earlier.start.character + 1} ` +
          `conflict with ${later.start.line + 1}:${later.start.character + 1}; ` +
          `multi-server rename produced inconsistent edits`,
      );
    }
  }
  return sorted;
}

/**
 * Apply text edits to a string in-memory. Edits are applied in reverse
 * order (bottom-to-top) to preserve line/character indices.
 */
function applyTextEditsToString(content: string, edits: readonly LspTextEdit[]): string {
  const lines = content.split('\n');
  const sortedEdits = sortAndValidateTextEdits(edits);

  for (const edit of sortedEdits) {
    const { start, end } = edit.range;
    if (start.line === end.line) {
      const line = lines[start.line] ?? '';
      lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character);
    } else {
      const startLine = lines[start.line] ?? '';
      const endLine = lines[end.line] ?? '';
      const newContent =
        startLine.slice(0, start.character) + edit.newText + endLine.slice(end.character);
      lines.splice(start.line, end.line - start.line + 1, ...newContent.split('\n'));
    }
  }

  return lines.join('\n');
}

/**
 * Flatten a WorkspaceEdit's text edits into a Map<path, TextEdit[]>.
 * Resource operations (create/rename/delete) are ignored — callers handle
 * them separately.
 */
function flattenWorkspaceTextEdits(
  edit: LspWorkspaceEdit,
): Map<string, LspTextEdit[]> {
  const out = new Map<string, LspTextEdit[]>();
  const push = (uri: string, edits: readonly LspTextEdit[]) => {
    if (edits.length === 0) return;
    const path = uriToPath(uri);
    const prev = out.get(path);
    if (prev) prev.push(...edits);
    else out.set(path, [...edits]);
  };
  if (edit.changes) {
    for (const uri of Object.keys(edit.changes)) {
      push(uri, edit.changes[uri]!);
    }
  }
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if (change && change.textDocument && change.edits) {
        push(change.textDocument.uri, change.edits);
      }
    }
  }
  return out;
}

/**
 * Apply a workspace edit (collection of file changes) to disk via Jian.
 *
 * All text-edit batches are overlap-validated before anything is written
 * so a conflict throws without leaving the workspace half-applied. Every
 * target path is passed through `validatePath` first — throws
 * `LspEditPathValidationError` if any path is outside the allowed root.
 */
export async function applyWorkspaceEdit(
  edit: LspWorkspaceEdit,
  jian: Pick<Jian, 'readText' | 'writeText'>,
  validatePath?: (path: string) => void,
): Promise<AppliedEdit[]> {
  const flattened = flattenWorkspaceTextEdits(edit);
  for (const edits of flattened.values()) {
    sortAndValidateTextEdits(edits);
  }
  if (validatePath !== undefined) {
    for (const filePath of flattened.keys()) {
      validatePath(filePath);
    }
  }

  const applied: AppliedEdit[] = [];
  for (const [filePath, edits] of flattened) {
    const content = await jian.readText(filePath);
    const result = applyTextEditsToString(content, edits);
    await jian.writeText(filePath, result);
    applied.push({ filePath, editCount: edits.length });
  }
  return applied;
}

/**
 * Format a workspace edit as a summary list (one entry per affected file).
 * Used for the preview mode (`apply: false`) where we show what *would*
 * change without writing to disk.
 */
export function formatWorkspaceEditPreview(edit: LspWorkspaceEdit): readonly string[] {
  const lines: string[] = [];
  if (edit.changes) {
    for (const uri of Object.keys(edit.changes)) {
      const edits = edit.changes[uri]!;
      const path = uriToPath(uri);
      lines.push(`${path}: ${String(edits.length)} edit${edits.length > 1 ? 's' : ''}`);
    }
  }
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if (change && change.textDocument && change.edits) {
        const path = uriToPath(change.textDocument.uri);
        lines.push(`${path}: ${String(change.edits.length)} edit${change.edits.length > 1 ? 's' : ''}`);
      }
    }
  }
  return lines;
}
