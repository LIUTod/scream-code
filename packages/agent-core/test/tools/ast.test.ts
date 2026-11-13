import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { matchPermissionRule } from '../../src/agent/permission/matches-rule';
import type { PermissionRule } from '../../src/agent/permission/types';
import type { LspDiagnostic } from '../../src/lsp/client';
import type { LspRegistry } from '../../src/lsp/registry';
import { AstEditInputSchema, AstEditTool } from '../../src/tools/builtin/ast/ast-edit';
import { AstGrepTool } from '../../src/tools/builtin/ast/ast-grep';
import { pathBasename } from '../../src/tools/builtin/ast/pattern';
import {
  EDIT_RECOVERY_INSTRUCTION,
  EditRecoveryQueue,
} from '../../src/tools/support/edit-recovery-queue';
import type { WorkspaceConfig } from '../../src/tools/support/workspace';
import { testJian } from '../fixtures/test-jian';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;
let root: string;
let workspace: WorkspaceConfig;

const SOURCE = [
  'const one = 1;',
  'console.log(one);',
  'console.log(one + 1);',
  'function helper(value: number) {',
  '  return value * 2;',
  '}',
].join('\n');

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'scream-ast-'));
  workspace = { workspaceDir: root, additionalDirs: [] };
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function context(args: Record<string, unknown>) {
  return { turnId: '0', toolCallId: 'call_ast', args: args as never, signal };
}

/**
 * Registry whose already-running client publishes a fixed diagnostics list.
 * `observed: true` because the tool must treat it as a real observation.
 */
function fakeDiagnosticsRegistry(diagnostics: readonly LspDiagnostic[]): LspRegistry {
  const client = {
    didOpen: () => {},
    didChange: () => {},
    diagnosticsReport: async () => ({ diagnostics: [...diagnostics], observed: true }),
  };
  return {
    getClient: async () => client,
    languageIdForPath: () => 'typescript',
    commandForPath: () => ['typescript-language-server', '--stdio'],
    stopAll: async () => {},
  } as unknown as LspRegistry;
}

describe('ast tools', () => {
  it('exposes metadata and schema', () => {
    const grep = new AstGrepTool(testJian, workspace);
    expect(grep.name).toBe('ast_grep');
    expect(grep.parameters).toMatchObject({ type: 'object', properties: { pattern: { type: 'string' } } });

    const edit = new AstEditTool(testJian, workspace);
    expect(edit.name).toBe('ast_edit');
    expect(AstEditInputSchema.safeParse({ pattern: 'a($B)', rewrite: 'b($B)', path: 'x.ts' }).success).toBe(true);
    expect(AstEditInputSchema.safeParse({ pattern: 'a($B)', path: 'x.ts' }).success).toBe(false);
  });

  it('finds structural matches in a single file', async () => {
    const file = join(root, 'single.ts');
    await writeFile(file, SOURCE);

    const result = await executeTool(new AstGrepTool(testJian, workspace), context({ pattern: 'console.log($A)', path: file }));
    expect(result.isError).toBe(false);
    expect(result.output).toContain('2 match(es) in 1 file(s)');
    expect(result.output).toContain('single.ts:2:1');
    expect(result.output).toContain('single.ts:3:1');
  });

  it('walks directories, skips node_modules, and reports zero matches cleanly', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'src', 'walk.ts'), SOURCE);
    await writeFile(join(root, 'node_modules', 'pkg', 'skip.ts'), SOURCE);

    const walked = await executeTool(new AstGrepTool(testJian, workspace), context({ pattern: 'console.log($A)' }));
    expect(walked.isError).toBe(false);
    expect(walked.output).toContain('src/walk.ts');
    expect(walked.output).not.toContain('node_modules');

    const empty = await executeTool(new AstGrepTool(testJian, workspace), context({ pattern: 'never.called($A)', path: join(root, 'src') }));
    expect(empty.isError).toBe(false);
    expect(empty.output).toContain('No AST matches');
  });

  it('previews a rewrite without touching the file', async () => {
    const file = join(root, 'preview.ts');
    await writeFile(file, 'add(1, 2);\nadd(3, 4);\n');

    const result = await executeTool(
      new AstEditTool(testJian, workspace),
      context({ pattern: 'add($A, $B)', rewrite: 'sum($A, $B)', path: file }),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Preview: 2 match(es) → 2 replacement(s)');
    expect(result.output).toContain('+sum(1, 2);');
    expect(result.output).toContain('expected_matches=2');
    expect(await readFile(file, 'utf8')).toBe('add(1, 2);\nadd(3, 4);\n');
  });

  it('requires expected_matches for apply and rewrites when it matches', async () => {
    const file = join(root, 'apply.ts');
    await writeFile(file, 'add(1, 2);\nadd(3, 4);\n');
    const tool = new AstEditTool(testJian, workspace);
    const base = { pattern: 'add($A, $B)', rewrite: 'sum($A, $B)', path: file, mode: 'apply' };

    const missing = await executeTool(tool, context(base));
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain('expected_matches=2');

    const wrong = await executeTool(tool, context({ ...base, expected_matches: 3 }));
    expect(wrong.isError).toBe(true);
    expect(wrong.output).toContain('Refusing to apply');

    const applied = await executeTool(tool, context({ ...base, expected_matches: 2 }));
    expect(applied.isError).toBe(false);
    expect(applied.output).toContain('Applied 2 replacement(s)');
    expect(await readFile(file, 'utf8')).toBe('sum(1, 2);\nsum(3, 4);\n');
  });

  it('refuses to apply when the file changed since the preview', async () => {
    const file = join(root, 'changed.ts');
    await writeFile(file, 'add(1, 2);\n');
    const tool = new AstEditTool(testJian, workspace);
    const preview = await executeTool(tool, context({ pattern: 'add($A, $B)', rewrite: 'sum($A, $B)', path: file }));
    expect(preview.output).toContain('1 match(es)');

    await writeFile(file, 'add(1, 2);\nadd(5, 6);\n');
    const apply = await executeTool(
      tool,
      context({ pattern: 'add($A, $B)', rewrite: 'sum($A, $B)', path: file, mode: 'apply', expected_matches: 1 }),
    );
    expect(apply.isError).toBe(true);
    expect(apply.output).toMatch(/Refusing to apply/);
    expect(apply.output).toContain('expected_matches=1');
    expect(await readFile(file, 'utf8')).toBe('add(1, 2);\nadd(5, 6);\n');
  });

  it('rejects $$$ rewrites and unknown metavariables with guidance', async () => {
    const file = join(root, 'reject.ts');
    await writeFile(file, 'call(1);\n');
    const tool = new AstEditTool(testJian, workspace);

    const multi = await executeTool(tool, context({ pattern: 'call($A)', rewrite: 'wrap($$$ARGS)', path: file }));
    expect(multi.isError).toBe(true);
    expect(multi.output).toContain('$$$');

    const unknown = await executeTool(tool, context({ pattern: 'call($A)', rewrite: 'wrap($B)', path: file }));
    expect(unknown.isError).toBe(true);
    expect(unknown.output).toContain('$B');
  });
  it('matches an approval rule against the file path, not the AST pattern', async () => {
    const file = join(root, 'rule.ts');
    await writeFile(file, SOURCE);
    const tool = new AstEditTool(testJian, workspace);
    const execution = await tool.resolveExecution({
      pattern: 'console.log($A)',
      rewrite: 'silence($A)',
      path: file,
    });

    // resolveExecution of a successful tool call always yields a runnable
    // execution; the error arm carries no matcher.
    if (execution.isError === true) throw new Error('ast_edit refused to resolve');
    const match = (pattern: string) =>
      matchPermissionRule({
        rule: { decision: 'allow', scope: 'session-runtime', pattern } as PermissionRule,
        toolName: tool.name,
        execution,
      });

    // A session "always allow" for this file keeps matching the same edit ...
    expect(match(`ast_edit(${file})`)).toBeDefined();
    // ... while a rule phrased with the AST pattern does not: the pattern is
    // the edit's content, not the subject being authorised.
    expect(match('ast_edit(console.log($A))')).toBeUndefined();
  });

  it('reports a truncated scan instead of claiming a complete total', async () => {
    const dir = join(root, 'many');
    await mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: 205 }, (_value, index) =>
        writeFile(join(dir, `f${String(index)}.ts`), 'const counted = 1;\n'),
      ),
    );

    const result = await executeTool(
      new AstGrepTool(testJian, workspace),
      context({ pattern: 'console.log($A)', path: dir }),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('scan truncated at 200 files');
  });

  it('follows a symlink passed as the explicit path', async () => {
    const target = join(root, 'symlink-target.ts');
    await writeFile(target, SOURCE);
    const link = join(root, 'symlink-entry.ts');
    await symlink(target, link);

    const result = await executeTool(
      new AstGrepTool(testJian, workspace),
      context({ pattern: 'console.log($A)', path: link }),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('2 match(es) in 1 file(s)');
  });

  it('clears a pending edit-recovery reminder when an apply fixes it', async () => {
    const file = join(root, 'recover.ts');
    await writeFile(file, 'add(1, 2);\n');
    // The queue keys on the canonical path, the one the tool resolves.
    const canonical = await testJian.realpath(file, { allowMissing: true });
    const queue = new EditRecoveryQueue();
    queue.enqueue({
      path: canonical,
      displayPath: file,
      signatures: [
        { signature: '1:Cannot find name add:0', line: 1, message: 'Cannot find name add' },
      ],
      instruction: EDIT_RECOVERY_INSTRUCTION,
    });

    const result = await executeTool(
      new AstEditTool(testJian, workspace, fakeDiagnosticsRegistry([]), queue),
      context({
        pattern: 'add($A, $B)',
        rewrite: 'sum($A, $B)',
        path: file,
        mode: 'apply',
        expected_matches: 1,
      }),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Applied 1 replacement(s)');
    expect(queue.drain()).toEqual([]);
  });
});

describe('pathBasename', () => {
  it('takes the basename with either separator', () => {
    expect(pathBasename('/a/b/c.ts')).toBe('c.ts');
    expect(pathBasename('C:\\a\\b\\c.ts')).toBe('c.ts');
  });
});
