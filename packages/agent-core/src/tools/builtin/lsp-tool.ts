import { z } from 'zod';

import type { Agent } from '#/agent';
import type { BuiltinTool } from '../../agent/tool';
import { ToolAccesses } from '../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../loop/types';
import { isWithinWorkspace, resolvePathAccessPath } from '../policies/path-access';
import { toInputJsonSchema } from '../support/input-schema';
import type { WorkspaceConfig } from '../support/workspace';
import type { LspRegistry } from '../../lsp/registry';
import type { LspWorkspaceEdit } from '../../lsp/client';
import { formatDiagnostic, formatLocation, formatOutlineEntry } from '../../lsp/client';
import { applyWorkspaceEdit, formatWorkspaceEditPreview } from '../../lsp/edits';

/** document_symbols listing cap; the trailer reports how many were hidden. */
const OUTLINE_LIST_CAP = 200;
/** Whole-document default for code_actions: an end line past any real file. */
const WHOLE_DOCUMENT_END_LINE = Number.MAX_SAFE_INTEGER;

interface LspRange {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

/** `1:5-1:12` style range label (1-based, matching formatLocation/formatDiagnostic). */
function formatRange(range: LspRange): string {
  return `${String(range.start.line + 1)}:${String(range.start.character + 1)}-${String(range.end.line + 1)}:${String(range.end.character + 1)}`;
}

/** First text edit's range in a workspace edit — a stable hint for where an action applies. */
function firstEditRange(edit: LspWorkspaceEdit | undefined): LspRange | undefined {
  if (edit === undefined) return undefined;
  if (edit.changes !== undefined) {
    for (const uri of Object.keys(edit.changes)) {
      const first = edit.changes[uri]?.[0];
      if (first !== undefined) return first.range;
    }
  }
  if (edit.documentChanges !== undefined) {
    for (const change of edit.documentChanges) {
      const first = change.edits[0];
      if (first !== undefined) return first.range;
    }
  }
  return undefined;
}

export const LspInputSchema = z.object({
  path: z
    .string()
    .optional()
    .describe(
      "Path to the source file. Required for every operation except 'symbols' (which is workspace-wide). Relative paths resolve against the working directory; a path outside the working directory must be absolute.",
    ),
  operation: z
    .enum([
      'symbols',
      'document_symbols',
      'references',
      'definition',
      'type_definition',
      'implementation',
      'hover',
      'diagnostics',
      'code_actions',
      'rename',
    ])
    .describe(
      "LSP operation to perform: 'symbols' (search workspace symbols by name), 'document_symbols' (flattened outline of one file), 'references', 'definition', 'type_definition', 'implementation', 'hover', 'diagnostics', 'code_actions' (list quick fixes / refactorings), or 'rename'.",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "For 'symbols': the symbol name (or part of it) to search for across the workspace. Required for symbols; ignored by other operations.",
    ),
  line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based line number for references/definition/hover/type_definition/implementation/rename.'),
  character: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      '0-based column/character offset for references/definition/hover/type_definition/implementation/rename.',
    ),
  include_declaration: z
    .boolean()
    .optional()
    .describe("For 'references': whether to include the declaration site in the results."),
  new_name: z
    .string()
    .optional()
    .describe(
      "For 'rename': the new symbol name. Required for rename. The rename is applied to disk only when `apply` is true.",
    ),
  apply: z
    .boolean()
    .optional()
    .describe(
      "For 'rename': when true, apply the rename to disk across all affected files. When false (default), return a preview of the changes without writing. Pass true only after previewing.",
    ),
  start_line: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "For 'code_actions': 0-based start line of the range the actions apply to (defaults to 0 — whole document).",
    ),
  start_character: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("For 'code_actions': 0-based character offset of the range start (defaults to 0)."),
  end_line: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "For 'code_actions': 0-based end line of the range (defaults past the end of the document — whole document).",
    ),
  end_character: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("For 'code_actions': 0-based character offset of the range end (defaults to 0)."),
  kinds: z
    .string()
    .optional()
    .describe(
      "For 'code_actions': comma-separated LSP action kinds to keep, e.g. 'refactor,quickfix'. Matching is prefix-based, so 'refactor' also keeps 'refactor.extract'.",
    ),
  apply_action: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "For 'code_actions': the index (from a previous code_actions listing) of the action to apply to disk. Omit to list actions without writing. Use the same path/range/kinds as the listing call so indices match. Only rename and code_actions with apply_action write files.",
    ),
});

export type LspInput = z.infer<typeof LspInputSchema>;

/**
 * LSP tool — code intelligence via language servers.
 *
 * Supports references, go-to-definition, type/implementation jumps, hover,
 * per-file outlines, diagnostics, code actions, and rename. The file content
 * is opened in the language server so results reflect the current editor
 * state even when the file has not been saved to disk. Only rename (with
 * `apply: true`) and code_actions (with `apply_action`) write files; all
 * other operations are read-only.
 */
export class LspTool implements BuiltinTool<LspInput> {
  readonly name = 'LSP' as const;
  readonly description = [
    'Query a language server for code intelligence: search workspace symbols by name, outline a single file, find usages, jump to definitions, list type/implementation locations, inspect hover docs, get diagnostics, list quick fixes and refactorings, or rename a symbol across all references.',
    'The language server is started automatically for supported file types (TypeScript/JavaScript, Python, Rust, Go).',
    "'symbols' is workspace-wide but only covers files inside the tsconfig project anchored at the workspace root; results outside it (or matches inside string literals) are invisible — cross-check with Grep when a miss is surprising.",
    'The other operations need a file `path` (plus line/character where relevant).',
    'Rename requires the typescript-language-server (or equivalent) binary on PATH for the file type.',
    'Only rename (with `apply: true`) and code_actions (with `apply_action`) write files; every other operation is read-only.',
  ].join(' ');
  readonly parameters: Record<string, unknown> = toInputJsonSchema(LspInputSchema);

  constructor(
    private readonly agent: Agent,
    private readonly workspace: WorkspaceConfig,
    private readonly lspRegistry: LspRegistry,
  ) {}

  async resolveExecution(args: LspInput): Promise<ToolExecution> {
    const isWrite =
      (args.operation === 'rename' && args.apply === true) ||
      (args.operation === 'code_actions' && args.apply_action !== undefined);
    if (isWrite && this.agent.getCapabilityMode() === 'read-only') {
      if (args.operation === 'code_actions') {
        throw new Error(
          'LSP `code_actions` with `apply_action` writes files, which read-only capability mode forbids. Call code_actions without `apply_action` to preview the actions instead.',
        );
      }
      throw new Error(
        'LSP `rename` with `apply: true` writes files, which read-only capability mode forbids. Call rename without `apply` to preview the edit instead.',
      );
    }
    const path = await resolvePathAccessPath(args.path ?? this.workspace.workspaceDir, {
      jian: this.agent.jian,
      workspace: this.workspace,
      operation: isWrite ? 'write' : 'read',
    });
    return {
      accesses: isWrite ? ToolAccesses.writeFile(path) : ToolAccesses.readFile(path),
      description: `LSP ${args.operation}${args.query !== undefined ? ` ${args.query}` : ''} ${args.path ?? this.workspace.workspaceDir}`,
      approvalRule: this.name,
      execute: () => this.execution(args, path),
    };
  }

  private async execution(args: LspInput, safePath: string): Promise<ExecutableToolResult> {
    if (args.operation === 'symbols') {
      if (args.query === undefined || args.query.trim().length === 0) {
        return { isError: true, output: "'symbols' requires 'query' (the symbol name to search for)." };
      }
      const client = await this.lspRegistry.getWorkspaceClient(this.workspace.workspaceDir);
      if (client === undefined) {
        return {
          isError: true,
          output:
            'No language server configured. Supported file extensions: .ts, .tsx, .js, .jsx, .py, .rs, .go.',
        };
      }
      try {
        const symbols = await client.workspaceSymbols(args.query.trim(), 30_000);
        if (symbols.length === 0) {
          return {
            isError: false,
            output:
              `No symbols matching '${args.query.trim()}' in the loaded project.\n` +
              'Note: symbols only covers files inside the tsconfig project anchored at the workspace; ' +
              'files outside it (or string literals) are invisible to this search — cross-check with Grep.',
          };
        }
        const lines = symbols.map(
          (s) =>
            `${s.name}${s.containerName !== undefined && s.containerName.length > 0 ? ` (in ${s.containerName})` : ''} — ${formatLocation(s.location)}`,
        );
        return {
          isError: false,
          output: [`Found ${lines.length} symbol(s):`, '', ...lines].join('\n'),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // tsserver occasionally answers "No Project" even after seeding
        // (project reload races). One self-healing retry: re-seed the client
        // with a project file, then re-issue the request once.
        if (/no project/i.test(message)) {
          await this.lspRegistry.reseedWorkspaceClient(this.workspace.workspaceDir);
          const retryClient = await this.lspRegistry.getWorkspaceClient(this.workspace.workspaceDir);
          if (retryClient !== undefined) {
            try {
              const retried = await retryClient.workspaceSymbols(args.query.trim());
              if (retried.length > 0) {
                const lines = retried.map(
                  (s) =>
                    `${s.name}${s.containerName !== undefined && s.containerName.length > 0 ? ` (in ${s.containerName})` : ''} — ${formatLocation(s.location)}`,
                );
                return {
                  isError: false,
                  output: [`Found ${lines.length} symbol(s):`, '', ...lines].join('\n'),
                };
              }
              return { isError: false, output: `No symbols matching '${args.query.trim()}'.` };
            } catch {
              // Fall through to the generic error below.
            }
          }
        }
        return { isError: true, output: `LSP request failed: ${message}` };
      }
    }

    const client = await this.lspRegistry.getClient(safePath, this.workspace.workspaceDir);
    if (client === undefined) {
      return {
        isError: true,
        output: `No language server configured for ${args.path ?? safePath}. Supported file extensions: .ts, .tsx, .js, .jsx, .py, .rs, .go.`,
      };
    }

    let content: string;
    try {
      content = await this.agent.jian.readText(safePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, output: `Failed to read ${args.path}: ${message}` };
    }

    const languageId = this.lspRegistry.languageIdForPath(safePath);
    if (languageId === undefined) {
      return {
        isError: true,
        output: `Could not determine language id for ${args.path}.`,
      };
    }

    client.didOpen(safePath, content, languageId);

    try {
      switch (args.operation) {
        case 'references': {
          if (args.line === undefined || args.character === undefined) {
            return {
              isError: true,
              output: "'references' requires both 'line' and 'character'.",
            };
          }
          const locations = await client.references(
            safePath,
            args.line - 1,
            args.character,
            args.include_declaration ?? false,
          );
          if (locations.length === 0) {
            return { isError: false, output: 'No references found.' };
          }
          return {
            isError: false,
            output: [`Found ${locations.length} reference(s):`, '', ...locations.map(formatLocation)].join('\n'),
          };
        }
        case 'definition': {
          if (args.line === undefined || args.character === undefined) {
            return {
              isError: true,
              output: "'definition' requires both 'line' and 'character'.",
            };
          }
          const locations = await client.definition(safePath, args.line - 1, args.character);
          if (locations.length === 0) {
            return { isError: false, output: 'No definition found.' };
          }
          return {
            isError: false,
            output: [`Found ${locations.length} definition(s):`, '', ...locations.map(formatLocation)].join('\n'),
          };
        }
        case 'diagnostics': {
          const diagnostics = await client.diagnostics(safePath);
          if (diagnostics.length === 0) {
            return { isError: false, output: 'No diagnostics for this file.' };
          }
          return {
            isError: false,
            output: [`${diagnostics.length} diagnostic(s):`, '', ...diagnostics.map(formatDiagnostic)].join('\n'),
          };
        }
        case 'document_symbols': {
          const outline = await client.documentSymbol(safePath);
          if (outline.length === 0) {
            return { isError: false, output: 'No symbols returned for this file.' };
          }
          const entries = outline
            .slice(0, OUTLINE_LIST_CAP)
            .map((entry) => `${'  '.repeat(entry.depth)}${formatOutlineEntry(entry)}`);
          if (outline.length > OUTLINE_LIST_CAP) {
            entries.push(`… and ${String(outline.length - OUTLINE_LIST_CAP)} more`);
          }
          return {
            isError: false,
            output: [`Found ${String(outline.length)} symbol(s):`, '', ...entries].join('\n'),
          };
        }
        case 'hover': {
          if (args.line === undefined || args.character === undefined) {
            return {
              isError: true,
              output: "'hover' requires both 'line' and 'character'.",
            };
          }
          const hover = await client.hover(safePath, args.line - 1, args.character);
          if (hover === null) {
            return { isError: false, output: 'No hover information.' };
          }
          const parts = [hover.contents];
          if (hover.range !== undefined) {
            parts.push(`Range: ${formatRange(hover.range)}`);
          }
          const hoverOutput = parts.filter((part) => part.length > 0).join('\n\n');
          if (hoverOutput.length === 0) {
            return { isError: false, output: 'No hover information.' };
          }
          return { isError: false, output: hoverOutput };
        }
        case 'type_definition': {
          if (args.line === undefined || args.character === undefined) {
            return {
              isError: true,
              output: "'type_definition' requires both 'line' and 'character'.",
            };
          }
          const locations = await client.typeDefinition(safePath, args.line - 1, args.character);
          if (locations.length === 0) {
            return { isError: false, output: 'No results found.' };
          }
          return {
            isError: false,
            output: [
              `Found ${String(locations.length)} type definition(s):`,
              '',
              ...locations.map(formatLocation),
            ].join('\n'),
          };
        }
        case 'implementation': {
          if (args.line === undefined || args.character === undefined) {
            return {
              isError: true,
              output: "'implementation' requires both 'line' and 'character'.",
            };
          }
          const locations = await client.implementation(safePath, args.line - 1, args.character);
          if (locations.length === 0) {
            return { isError: false, output: 'No results found.' };
          }
          return {
            isError: false,
            output: [
              `Found ${String(locations.length)} implementation(s):`,
              '',
              ...locations.map(formatLocation),
            ].join('\n'),
          };
        }
        case 'code_actions': {
          const kindFilter =
            args.kinds !== undefined
              ? args.kinds
                  .split(',')
                  .map((kind) => kind.trim())
                  .filter((kind) => kind.length > 0)
              : undefined;
          const actions = await client.codeActions(
            safePath,
            args.start_line ?? 0,
            args.start_character ?? 0,
            args.end_line ?? WHOLE_DOCUMENT_END_LINE,
            args.end_character ?? 0,
          );
          // Second-stage filter — the only filter there is. No server-side
          // `context.only` is sent (see client.codeActions), so indexes stay
          // full-list-relative across calls with and without `kinds`, and
          // `apply_action` always addresses the same action it listed.
          const filtered =
            kindFilter !== undefined && kindFilter.length > 0
              ? actions.filter((action) =>
                  action.kind !== undefined
                    ? kindFilter.some((kind) => action.kind === kind || action.kind!.startsWith(`${kind}.`))
                    : false,
                )
              : actions;
          if (args.apply_action !== undefined) {
            const selected = filtered.find((action) => action.index === args.apply_action);
            if (selected === undefined) {
              return {
                isError: true,
                output:
                  `No code action with index ${String(args.apply_action)} for this range. ` +
                  `The server returned ${String(filtered.length)} action(s); re-run without 'apply_action' to list their indices.`,
              };
            }
            if (selected.edit === undefined) {
              return {
                isError: true,
                output: `Code action "${selected.title}" has no workspace edit to apply (it may be a server-side command).`,
              };
            }
            const applied = await applyWorkspaceEdit(
              selected.edit,
              this.agent.jian,
              (p) => {
                if (!isWithinWorkspace(p, this.workspace, this.agent.jian.pathClass())) {
                  throw new Error(
                    `Refusing to apply code action: LSP returned edits for a file outside the workspace: ${p}`,
                  );
                }
              },
            );
            if (applied.length === 0) {
              return { isError: false, output: `Action "${selected.title}" produced no file changes.` };
            }
            return {
              isError: false,
              output: `Applied action "${selected.title}" to ${String(applied.length)} file(s).`,
            };
          }
          if (filtered.length === 0) {
            return { isError: false, output: 'No code actions available for this range.' };
          }
          const entries = filtered.map((action) => {
            const parts = [`${String(action.index)}. ${action.title}`];
            if (action.kind !== undefined) parts.push(action.kind);
            const range = firstEditRange(action.edit);
            if (range !== undefined) parts.push(formatRange(range));
            return parts.join(' — ');
          });
          return {
            isError: false,
            output: [`Found ${String(filtered.length)} code action(s):`, '', ...entries].join('\n'),
          };
        }
        case 'rename': {
          if (args.line === undefined || args.character === undefined) {
            return {
              isError: true,
              output: "'rename' requires both 'line' and 'character'.",
            };
          }
          if (args.new_name === undefined || args.new_name === '') {
            return {
              isError: true,
              output: "'rename' requires 'new_name'.",
            };
          }
          const workspaceEdit = await client.rename(
            safePath,
            args.line - 1,
            args.character,
            args.new_name,
          );
          if (workspaceEdit === null) {
            return { isError: false, output: 'Rename returned no edits.' };
          }
          const shouldApply = args.apply === true;
          if (shouldApply) {
            const applied = await applyWorkspaceEdit(
              workspaceEdit,
              this.agent.jian,
              (p) => {
                if (!isWithinWorkspace(p, this.workspace, this.agent.jian.pathClass())) {
                  throw new Error(
                    `Refusing to apply rename: LSP returned edits for a file outside the workspace: ${p}`,
                  );
                }
              },
            );
            if (applied.length === 0) {
              return { isError: false, output: 'Rename produced no file changes.' };
            }
            const lines = applied.map(
              (a) => `  Applied ${String(a.editCount)} edit(s) to ${a.filePath}`,
            );
            return {
              isError: false,
              output: [`Applied rename to ${String(applied.length)} file(s):`, ...lines].join('\n'),
            };
          }
          const preview = formatWorkspaceEditPreview(workspaceEdit);
          if (preview.length === 0) {
            return { isError: false, output: 'Rename preview is empty.' };
          }
          return {
            isError: false,
            output: [`Rename preview (${String(preview.length)} file(s)):`, ...preview].join('\n'),
          };
        }
        default: {
          return { isError: true, output: `Unsupported operation: ${String(args.operation)}` };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, output: `LSP request failed: ${message}` };
    }
  }
}
