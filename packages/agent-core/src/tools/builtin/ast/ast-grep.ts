import { z } from 'zod';
import type { Jian } from '@scream-code/jian';
import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { resolvePathAccessPath } from '../../policies/path-access';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { toInputJsonSchema } from '../../support/input-schema';
import type { WorkspaceConfig } from '../../support/workspace';
import {
  AST_MAX_FILES,
  AST_MAX_MATCHES,
  formatAstMatch,
  isFileMode,
  inferAstLanguage,
  loadAstGrep,
  resolveAstLang,
  walkAstFiles,
  type AstLanguage,
  type AstWalkState,
} from './pattern';
import AST_GREP_DESCRIPTION from './ast-grep.md';

export const AstGrepInputSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('ast-grep pattern over source text, e.g. "console.log($A)" or "if ($COND) { $$$BODY }".'),
  language: z
    .enum(['typescript', 'tsx', 'javascript'])
    .optional()
    .describe('Source language; inferred from the file extension when omitted.'),
  path: z
    .string()
    .optional()
    .describe('File or directory to search. Defaults to the workspace root; directories are walked recursively.'),
});

export type AstGrepInput = z.infer<typeof AstGrepInputSchema>;

export class AstGrepTool implements BuiltinTool<AstGrepInput> {
  readonly name = 'ast_grep';
  readonly description = AST_GREP_DESCRIPTION;
  readonly parameters = toInputJsonSchema(AstGrepInputSchema);

  constructor(
    private readonly jian: Jian,
    private readonly workspace: WorkspaceConfig,
  ) {}

  async resolveExecution(args: AstGrepInput): Promise<ToolExecution> {
    const requested = args.path ?? this.workspace.workspaceDir;
    const safePath = await resolvePathAccessPath(requested, {
      jian: this.jian,
      workspace: this.workspace,
      operation: 'search',
    });
    return {
      description: `Search ${safePath} by structure for \`${args.pattern}\``,
      approvalRule: literalRulePattern(this.name, args.pattern),
      accesses: ToolAccesses.searchTree(safePath),
      matchesRule: (rule) => matchesGlobRuleSubject(rule, args.pattern),
      execute: (ctx) => this.execute(args, safePath, ctx),
    };
  }

  private async execute(
    args: AstGrepInput,
    safePath: string,
    ctx: { signal: AbortSignal },
  ): Promise<ExecutableToolResult> {
    const mod = await loadAstGrep();
    if (mod === undefined) {
      return {
        output:
          'AST search is unavailable: the optional @ast-grep/napi dependency failed to load. Use Grep for text search instead.',
        isError: true,
      };
    }

    // The explicit path may itself be a symlink to a source file: resolve it
    // so a linked file is searched instead of being treated as an empty
    // directory. Entries found during the walk keep followSymlinks:false so a
    // link cannot pull the walk outside the searched tree.
    const stat = await this.jian.stat(safePath, { followSymlinks: true });
    const displayBase = this.workspace.workspaceDir;
    const isFile = isFileMode(stat.stMode);
    const files: string[] = [];
    const walkState: AstWalkState = { truncated: false };
    if (isFile) {
      // A single file must have an unambiguous language; a directory takes
      // the language per file (or from `language` when given).
      if ((args.language ?? inferAstLanguage(safePath)) === undefined) {
        return {
          output:
            'Cannot infer the language of that file. Pass language as one of: typescript, tsx, javascript.',
          isError: true,
        };
      }
      files.push(safePath);
    } else {
      for await (const file of walkAstFiles(this.jian, safePath, args.language, ctx.signal, walkState)) {
        files.push(file);
      }
    }

    const shown: string[] = [];
    let total = 0;
    let matchedFiles = 0;
    for (const file of files) {
      ctx.signal.throwIfAborted();
      const fileLanguage: AstLanguage | undefined = args.language ?? inferAstLanguage(file);
      if (fileLanguage === undefined) continue;
      let source: string;
      try {
        source = await this.jian.readText(file);
      } catch {
        continue;
      }
      const parsed = mod.parse(resolveAstLang(mod, fileLanguage), source);
      const matches = parsed.root().findAll({ rule: { pattern: args.pattern } });
      if (matches.length === 0) continue;
      matchedFiles += 1;
      total += matches.length;
      const displayPath = file.startsWith(displayBase) ? file.slice(displayBase.length + 1) : file;
      for (const match of matches) {
        if (shown.length >= AST_MAX_MATCHES) break;
        shown.push(formatAstMatch(displayPath, match));
      }
    }

    // A walk that hit the file cap did not see every candidate, so neither
    // total below may be presented as complete.
    const truncationNote = walkState.truncated
      ? ` (scan truncated at ${String(AST_MAX_FILES)} files — narrow the path)`
      : '';

    if (total === 0) {
      return {
        output: `No AST matches for pattern \`${args.pattern}\` in ${files.length} file(s)${truncationNote}.`,
        isError: false,
      };
    }

    const header = `${total} match(es) in ${matchedFiles} file(s) (scanned ${files.length})${truncationNote}`;
    const lines = [header, ...shown];
    if (total > shown.length) {
      lines.push(`(showing first ${shown.length}; narrow the pattern or path to see the rest)`);
    }
    return { output: lines.join('\n'), isError: false };
  }
}
