import { z } from 'zod';
import type { Jian } from '@scream-code/jian';
import type { BuiltinTool } from '../../../agent/tool';
import type { LspRegistry } from '../../../lsp/registry';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { resolvePathAccessPath } from '../../policies/path-access';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import { toInputJsonSchema } from '../../support/input-schema';
import { diffLineRuns, physicalLinesOf } from '../../support/line-diff';
import type { WorkspaceConfig } from '../../support/workspace';
import type { EditRecoveryQueue } from '../../support/edit-recovery-queue';
import { materializeModelText, toModelTextView } from '../file/line-endings';
import {
  fetchDiagnostics,
  formatDiagnosticsHint,
  formatDiagnosticsNotice,
  reconcileEditReminders,
} from '../file/lsp-diagnostics';
import { withFileMutationLock } from '../file/mutation-queue';
import AST_EDIT_DESCRIPTION from './ast-edit.md';
import {
  expandRewrite,
  inferAstLanguage,
  loadAstGrep,
  resolveAstLang,
  type AstLanguage,
} from './pattern';

export const AstEditInputSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('ast-grep pattern identifying the nodes to rewrite, e.g. "console.log($A)".'),
  rewrite: z
    .string()
    .min(1)
    .describe('Replacement template; $NAME placeholders take the matched nodes. $$$NAME is not supported.'),
  language: z
    .enum(['typescript', 'tsx', 'javascript'])
    .optional()
    .describe('Source language; inferred from the file extension when omitted.'),
  path: z.string().min(1).describe('File to rewrite.'),
  mode: z
    .enum(['preview', 'apply'])
    .optional()
    .describe('preview (default) returns the diff without writing; apply writes the file.'),
  expected_matches: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Required for apply: the match count the preview returned. Refuses to write when the file changed.'),
});

export type AstEditInput = z.infer<typeof AstEditInputSchema>;

const DIFF_CONTEXT_LINES = 2;
const DIFF_MAX_LINES = 40;

export class AstEditTool implements BuiltinTool<AstEditInput> {
  readonly name = 'ast_edit';
  readonly description = AST_EDIT_DESCRIPTION;
  readonly parameters = toInputJsonSchema(AstEditInputSchema);

  constructor(
    private readonly jian: Jian,
    private readonly workspace: WorkspaceConfig,
    private readonly lspRegistry?: LspRegistry,
    /**
     * Session queue of post-edit error reminders; absent outside an Agent.
     * Supplied so an apply that fixes a pending error clears its reminder —
     * the fix bypasses Edit, so Edit's own observation never runs.
     */
    private readonly editRecovery?: EditRecoveryQueue,
  ) {}

  async resolveExecution(args: AstEditInput): Promise<ToolExecution> {
    const applying = args.mode === 'apply';
    const safePath = await resolvePathAccessPath(args.path, {
      jian: this.jian,
      workspace: this.workspace,
      operation: applying ? 'write' : 'read',
    });
    return {
      description: `Rewrite \`${args.pattern}\` in ${safePath}${applying ? '' : ' (preview)'}`,
      approvalRule: literalRulePattern(this.name, args.path),
      accesses: applying ? ToolAccesses.writeFile(safePath) : ToolAccesses.readFile(safePath),
      // Same subject on both sides: a recorded approval covers the file, so
      // the rule argument is matched as a path — never as the AST pattern,
      // which is content, not the thing being authorised.
      matchesRule: (rule) =>
        matchesPathRuleSubject(rule, args.path, {
          cwd: this.workspace.workspaceDir,
          pathClass: this.jian.pathClass(),
          homeDir: this.jian.gethome(),
        }),
      execute: (ctx) => this.execute(args, safePath, ctx),
    };
  }

  private async execute(
    args: AstEditInput,
    safePath: string,
    ctx: { signal: AbortSignal },
  ): Promise<ExecutableToolResult> {
    if (args.rewrite.includes('$$$')) {
      return {
        output:
          '`$$$NAME` multi-capture expansion is not supported by ast_edit. Rewrite with single-node $NAME placeholders, split the edit, or use Edit for that change.',
        isError: true,
      };
    }

    const mod = await loadAstGrep();
    if (mod === undefined) {
      return {
        output:
          'AST rewriting is unavailable: the optional @ast-grep/napi dependency failed to load. Use Edit instead.',
        isError: true,
      };
    }

    const language: AstLanguage | undefined = args.language ?? inferAstLanguage(safePath);
    if (language === undefined) {
      return {
        output:
          'Cannot infer the language of that path. Pass language as one of: typescript, tsx, javascript.',
        isError: true,
      };
    }
    const lang = resolveAstLang(mod, language);
    const mode = args.mode ?? 'preview';

    const plan = async (): Promise<
      | { ok: true; matchCount: number; nextText: string; oldText: string; style: ReturnType<typeof toModelTextView>['lineEndingStyle'] }
      | { ok: false; output: string; isError: boolean }
    > => {
      const raw = await this.jian.readText(safePath);
      const modelView = toModelTextView(raw);
      const parsed = mod.parse(lang, modelView.text);
      const root = parsed.root();
      const matches = root.findAll({ rule: { pattern: args.pattern } });
      if (matches.length === 0) {
        return { ok: false, isError: false, output: `No AST matches for pattern \`${args.pattern}\` in ${args.path}; nothing to rewrite.` };
      }
      const missing = new Set<string>();
      const edits: unknown[] = [];
      for (const match of matches) {
        const expansion = expandRewrite(args.rewrite, match);
        if (!expansion.ok) {
          for (const name of expansion.missing) missing.add(name);
          continue;
        }
        edits.push(match.replace(expansion.text));
      }
      if (missing.size > 0) {
        return {
          ok: false,
          isError: true,
          output: `The rewrite references ${[...missing].map((name) => '$' + name).join(', ')}, which the pattern does not capture. Add the placeholder to the pattern or fix the rewrite.`,
        };
      }
      let nextText: string;
      try {
        // commitEdits applies edits to the SLICE OWNED BY THE NODE IT IS
        // CALLED ON, so it must be the root (whole source). Calling it on a
        // match node hands absolute edit positions to a subtree slice and
        // aborts the native process (verified by an engine panic in tests).
        nextText = root.commitEdits(edits as never[]);
      } catch {
        return {
          ok: false,
          isError: true,
          output:
            'The engine refused the edit set (overlapping matches). Narrow the pattern so matches cannot nest, then retry.',
        };
      }
      return { ok: true, matchCount: matches.length, nextText, oldText: modelView.text, style: modelView.lineEndingStyle };
    };

    const preview = await plan();
    if (!preview.ok) return { output: preview.output, isError: preview.isError };

    const diff = renderDiff(preview.oldText, preview.nextText);
    if (mode === 'preview') {
      return {
        output: [
          `Preview: ${preview.matchCount} match(es) → ${preview.matchCount} replacement(s) in ${args.path} (nothing written).`,
          ...(diff.length > 0 ? ['', diff] : []),
          '',
          `Apply with mode="apply", expected_matches=${preview.matchCount}.`,
        ].join('\n'),
        isError: false,
      };
    }

    if (args.expected_matches === undefined) {
      return {
        output: `apply requires expected_matches=${preview.matchCount} from the preview so a changed file is not rewritten blindly.`,
        isError: true,
      };
    }
    if (args.expected_matches !== preview.matchCount) {
      return {
        output: `Refusing to apply: the file now has ${preview.matchCount} match(es), but expected_matches=${args.expected_matches}. Re-run the preview.`,
        isError: true,
      };
    }
    if (preview.nextText.includes('<<<<<<<') || preview.nextText.includes('>>>>>>>')) {
      return {
        output: 'Refusing to write: the rewritten content contains merge conflict markers.',
        isError: true,
      };
    }

    const applied = await withFileMutationLock(safePath, async () => {
      ctx.signal.throwIfAborted();
      // Recompute against the CURRENT bytes under the lock: the preview and
      // the apply can be separated by other writes, and a count match on the
      // stale read would write a replacement for content that no longer
      // exists. The count is the contract — recompute it and compare.
      const fresh = await plan();
      if (!fresh.ok) return fresh;
      if (fresh.matchCount !== args.expected_matches) {
        return {
          ok: false as const,
          isError: true,
          output: `Refusing to apply: the file changed since the preview (now ${fresh.matchCount} match(es), expected ${args.expected_matches}). Re-run the preview.`,
        };
      }
      const written = materializeModelText(fresh.nextText, fresh.style);
      await this.jian.writeText(safePath, written);
      return { ok: true as const, matchCount: fresh.matchCount };
    });

    if (!applied.ok) return { output: applied.output, isError: applied.isError };

    const diagnostics = await fetchDiagnostics(this.lspRegistry, this.jian, safePath, this.workspace.workspaceDir);
    // This apply bypasses Edit, so Edit's diagnostics tracking never runs for
    // it: feed the observation into the reminder queue here so a fix that
    // resolves a pending reminder clears it.
    await reconcileEditReminders(this.editRecovery, this.jian, safePath, diagnostics);
    const notice = formatDiagnosticsNotice(diagnostics);
    const hint = formatDiagnosticsHint(diagnostics);
    const summary = `Applied ${applied.matchCount} replacement(s) in ${args.path}.`;
    const output = [summary, ...(diff.length > 0 ? ['', diff] : []), ...(notice.length > 0 ? ['', notice] : [])].join('\n');
    return { output, message: hint.length > 0 ? hint : undefined, isError: false };
  }
}

function renderDiff(before: string, after: string): string {
  const runs = diffLineRuns(physicalLinesOf(before), physicalLinesOf(after));
  if (runs === null) return '';
  const beforeLines = physicalLinesOf(before);
  const afterLines = physicalLinesOf(after);
  const lines: string[] = [];
  let emitted = 0;
  for (const run of runs) {
    if (run.type === 'equal') {
      const length = run.snapEnd - run.snapStart + 1;
      if (length <= DIFF_CONTEXT_LINES * 2) {
        for (let index = run.snapStart; index <= run.snapEnd && emitted < DIFF_MAX_LINES; index += 1) {
          lines.push(` ${beforeLines[index - 1] ?? ''}`);
          emitted += 1;
        }
      } else {
        const headEnd = run.snapStart + DIFF_CONTEXT_LINES - 1;
        for (let index = run.snapStart; index <= headEnd && emitted < DIFF_MAX_LINES; index += 1) {
          lines.push(` ${beforeLines[index - 1] ?? ''}`);
          emitted += 1;
        }
        lines.push('…');
        const tailStart = run.snapEnd - DIFF_CONTEXT_LINES + 1;
        for (let index = tailStart; index <= run.snapEnd && emitted < DIFF_MAX_LINES; index += 1) {
          lines.push(` ${beforeLines[index - 1] ?? ''}`);
          emitted += 1;
        }
      }
      continue;
    }
    if (run.type === 'delete') {
      for (let index = run.snapStart; index <= run.snapEnd && emitted < DIFF_MAX_LINES; index += 1) {
        lines.push(`-${beforeLines[index - 1] ?? ''}`);
        emitted += 1;
      }
      continue;
    }
    for (let index = run.curStart; index <= run.curEnd && emitted < DIFF_MAX_LINES; index += 1) {
      lines.push(`+${afterLines[index - 1] ?? ''}`);
      emitted += 1;
    }
  }
  if (emitted >= DIFF_MAX_LINES) lines.push('… (diff truncated)');
  return lines.join('\n');
}
