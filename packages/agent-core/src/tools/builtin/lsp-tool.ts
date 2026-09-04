import { z } from 'zod';

import type { Agent } from '#/agent';
import type { BuiltinTool } from '../../agent/tool';
import { ToolAccesses } from '../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../loop/types';
import { isWithinWorkspace, resolvePathAccessPath } from '../policies/path-access';
import { toInputJsonSchema } from '../support/input-schema';
import type { WorkspaceConfig } from '../support/workspace';
import type { LspRegistry } from '../../lsp/registry';
import { formatDiagnostic, formatLocation } from '../../lsp/client';
import { applyWorkspaceEdit, formatWorkspaceEditPreview } from '../../lsp/edits';

export const LspInputSchema = z.object({
  path: z
    .string()
    .optional()
    .describe(
      "Path to the source file. Required for references/definition/diagnostics/rename; NOT used for 'symbols'. Relative paths resolve against the working directory; a path outside the working directory must be absolute.",
    ),
  operation: z
    .enum(['symbols', 'references', 'definition', 'diagnostics', 'rename'])
    .describe(
      "LSP operation to perform: 'symbols' (search workspace symbols by name), 'references', 'definition', 'diagnostics', or 'rename'.",
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
    .describe('1-based line number for references/definition/rename.'),
  character: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('0-based column/character offset for references/definition/rename.'),
  include_declaration: z
    .boolean()
    .optional()
    .describe("For 'references': whether to include the declaration site in the results."),
  new_name: z
    .string()
    .optional()
    .describe(
      "For 'rename': the new symbol name. Required for rename. The rename is applied to disk unless `apply` is false.",
    ),
  apply: z
    .boolean()
    .optional()
    .describe(
      "For 'rename': when true, apply the rename to disk across all affected files. When false (default), return a preview of the changes without writing. Pass true only after previewing.",
    ),
});

export type LspInput = z.infer<typeof LspInputSchema>;

/**
 * LSP tool — code intelligence via language servers.
 *
 * Supports references, go-to-definition, diagnostics, and rename. The file
 * content is opened in the language server so results reflect the current
 * editor state even when the file has not been saved to disk. Rename is the
 * only write op; pass `apply: false` to preview without writing.
 */
export class LspTool implements BuiltinTool<LspInput> {
  readonly name = 'LSP' as const;
  readonly description = [
    'Query a language server for code intelligence: search workspace symbols by name, find usages, jump to definitions, get diagnostics, or rename a symbol across all references.',
    'The language server is started automatically for supported file types (TypeScript/JavaScript, Python, Rust, Go).',
    "'symbols' is workspace-wide but only covers files inside the tsconfig project anchored at the workspace root; results outside it (or matches inside string literals) are invisible — cross-check with Grep when a miss is surprising.",
    'The other operations need a file `path` (plus line/character where relevant).',
    'Rename requires the typescript-language-server (or equivalent) binary on PATH for the file type.',
  ].join(' ');
  readonly parameters: Record<string, unknown> = toInputJsonSchema(LspInputSchema);

  constructor(
    private readonly agent: Agent,
    private readonly workspace: WorkspaceConfig,
    private readonly lspRegistry: LspRegistry,
  ) {}

  async resolveExecution(args: LspInput): Promise<ToolExecution> {
    const isWrite = args.operation === 'rename' && args.apply === true;
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
