import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LspDiagnostic } from '../../src/lsp/client';
import type { LspRegistry } from '../../src/lsp/registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkingSet } from '../../src/agent/working-set';
import { type EditInput, EditInputSchema, EditTool } from '../../src/tools/builtin/file/edit';
import { computeAnchor, toModelTextView } from '../../src/tools/builtin/file/line-endings';
import { resetNoopLoop } from '../../src/tools/builtin/file/noop-loop-guard';
import { EditSnapshotStore } from '../../src/tools/support/edit-snapshot-store';
import { EditRecoveryQueue } from '../../src/tools/support/edit-recovery-queue';
import { fileDiffSummary } from '../../src/tools/support/file-diff';
import { testJian } from '../fixtures/test-jian';
import { createFakeJian, PERMISSIVE_WORKSPACE } from './fixtures/fake-jian';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function context(args: EditInput) {
  return { turnId: '0', toolCallId: 'call_edit', args, signal };
}

describe('EditTool', () => {
  it('exposes before/after on the file_io display so the approval panel can render a diff', async () => {
    const tool = new EditTool(createFakeJian(), PERMISSIVE_WORKSPACE);
    const execution = await tool.resolveExecution({
      path: '/tmp/foo.ts',
      old_string: 'a\nb\nc',
      new_string: 'a\nB\nc',
    });
    if (execution.isError === true) {
      throw new TypeError('expected runnable execution');
    }
    expect(execution.display).toEqual({
      kind: 'file_io',
      operation: 'edit',
      path: '/tmp/foo.ts',
      before: 'a\nb\nc',
      after: 'a\nB\nc',
    });
  });

  it('exposes current metadata and schema', () => {
    const tool = new EditTool(createFakeJian(), PERMISSIVE_WORKSPACE);

    expect(tool.name).toBe('Edit');
    expect(tool.description).toContain('text view returned by Read');
    expect(tool.description).toContain('old_string must occur exactly once');
    expect(tool.description).toContain('multiple Edit calls in parallel');
    // Editing files should go through Edit, not a Shell `sed` command.
    expect(tool.description).toContain('Shell `sed`');
    // Parallel Edit calls on the same file are serialized and applied in
    // response order; mismatched old_string fails explicitly.
    expect(tool.description).toContain('they apply in the order the calls appear in your response');
    expect(tool.description).toContain('old_string not found');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: expect.stringContaining('working directory'),
        },
        old_string: {
          type: 'string',
          description: expect.stringContaining('without the line-number prefix'),
        },
        new_string: {
          type: 'string',
          description: expect.stringContaining('same Read output view'),
        },
        anchor: {
          type: 'string',
          description: expect.stringContaining('Read'),
        },
      },
    });
    expect(
      EditInputSchema.safeParse({
        path: '/tmp/a.txt',
        old_string: 'old',
        new_string: 'new',
      }).success,
    ).toBe(true);
    expect(
      EditInputSchema.safeParse({
        path: '/tmp/a.txt',
        old_string: '',
        new_string: 'new',
      }).success,
    ).toBe(false);
    expect(
      EditInputSchema.safeParse({
        path: '/tmp/a.txt',
        old_string: 'old',
        new_string: 'new',
        anchor: 'a1b2c3d4',
      }).success,
    ).toBe(true);
  });

  it('succeeds when the provided anchor matches the current file content', async () => {
    const content = 'alpha beta';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool,
      context({
        path: '/tmp/a.txt',
        old_string: 'beta',
        new_string: 'gamma',
        anchor: computeAnchor(toModelTextView(content).text),
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Replaced 1 occurrence');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'alpha gamma');
  });

  it('fails when the provided anchor does not match the current file content', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('alpha beta'),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool,
      context({
        path: '/tmp/a.txt',
        old_string: 'beta',
        new_string: 'gamma',
        anchor: 'deadbeef',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('anchor no longer matches');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('replaces a unique first occurrence and writes the updated content', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('alpha beta'),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool,
      context({ path: '/tmp/a.txt', old_string: 'beta', new_string: 'gamma' }),
    );

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'alpha gamma');
  });

  it('serializes concurrent edits to the same file so both apply (no lost update)', async () => {
    // Shared mutable file state: without per-path serialization both edits read
    // the same original content and the second write clobbers the first.
    let content = 'alpha beta gamma';
    const readText = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return content;
    });
    const writeText = vi.fn(async (_path: string, next: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      content = next;
      return next.length;
    });
    const tool = new EditTool(
      createFakeJian({
        readText: readText as never,
        writeText: writeText as never,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const [first, second] = await Promise.all([
      executeTool(tool, context({ path: '/tmp/concurrent.txt', old_string: 'alpha', new_string: 'ALPHA' })),
      executeTool(tool, context({ path: '/tmp/concurrent.txt', old_string: 'gamma', new_string: 'GAMMA' })),
    ]);

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(content).toBe('ALPHA beta GAMMA');
  });

  it('expands leading tilde paths using the jian home directory', async () => {
    const readText = vi.fn().mockResolvedValue('alpha beta');
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(createFakeJian({ readText, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,
      context({ path: '~/notes/today.txt', old_string: 'beta', new_string: 'gamma' }),
    );

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(readText).toHaveBeenCalledWith('/home/test/notes/today.txt');
    expect(writeText).toHaveBeenCalledWith('/home/test/notes/today.txt', 'alpha gamma');
  });

  it('treats replacement dollar sequences literally for single edits', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('alpha beta gamma'),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool,
      context({ path: '/tmp/a.txt', old_string: 'beta', new_string: "$& $$ $` $'" }),
    );

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', "alpha $& $$ $` $' gamma");
  });

  it('treats replacement dollar sequences literally for replace_all edits', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('a b a'),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool,
      context({ path: '/tmp/a.txt', old_string: 'a', new_string: '$&', replace_all: true }),
    );

    expect(result.output).toContain('Replaced 2 occurrences');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', '$& b $&');
  });

  it('matches pure CRLF files through the LF model view and writes back CRLF', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('alpha\r\nbeta\r\ngamma\r\n'),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool,
      context({ path: '/tmp/a.txt', old_string: 'alpha\nbeta', new_string: 'one\ntwo' }),
    );

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'one\r\ntwo\r\ngamma\r\n');
  });

  it('does not double carriage returns when editing pure CRLF files', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('alpha\r\nbeta\r\n'),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool,
      context({ path: '/tmp/a.txt', old_string: 'alpha\nbeta', new_string: 'one\r\ntwo' }),
    );

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'one\r\ntwo\r\n');
  });

  it('keeps mixed line ending files on the raw exact path', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('alpha\r\nbeta\ngamma\r\n'),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool,
      context({ path: '/tmp/a.txt', old_string: 'alpha\nbeta', new_string: 'one\ntwo' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('old_string not found');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('allows exact raw edits in mixed line ending files without normalizing the rest', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('alpha\r\nbeta\ngamma\r\n'),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool,
      context({ path: '/tmp/a.txt', old_string: 'alpha\r\nbeta', new_string: 'one\r\ntwo' }),
    );

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'one\r\ntwo\ngamma\r\n');
  });

  it('replace_all replaces every occurrence', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('a b a'),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool,
      context({ path: '/tmp/a.txt', old_string: 'a', new_string: 'x', replace_all: true }),
    );

    expect(result.output).toContain('Replaced 2 occurrences');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'x b x');
  });

  it('rejects no-op edits before file I/O', async () => {
    const readText = vi.fn().mockResolvedValue('same');
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(createFakeJian({ readText, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,
      context({
        path: '/tmp/a.txt',
        old_string: 'same',
        new_string: 'same',
        replace_all: true,
      }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('No changes to make');
    expect(readText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('errors when old_string is missing', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('alpha beta'),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool,
      context({ path: '/tmp/a.txt', old_string: 'delta', new_string: 'gamma' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('old_string not found');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('errors when old_string is not unique and replace_all is false', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('same same'),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool,
      context({ path: '/tmp/a.txt', old_string: 'same', new_string: 'other' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('not unique');
    expect(result.output).toContain('set replace_all=true');
    expect(result.output).toContain('include more surrounding context');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects relative traversal edits before reading', async () => {
    const readText = vi.fn().mockResolvedValue('secret');
    const tool = new EditTool(createFakeJian({ readText }), {
      workspaceDir: '/workspace/project',
      additionalDirs: [],
    });

    const result = await executeTool(tool,
      context({ path: '../outside.txt', old_string: 'secret', new_string: 'x' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('absolute path');
    expect(readText).not.toHaveBeenCalled();
  });

  it('replaces unicode strings (CJK) and round-trips the surrounding text', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('Hello 世界! café'),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool,
      context({ path: '/tmp/u.txt', old_string: '世界', new_string: '地球' }),
    );

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(writeText).toHaveBeenCalledWith('/tmp/u.txt', 'Hello 地球! café');
  });

  it('leaves the file byte-identical when old_string is not present', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const original = 'Hello world!';
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(original),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool,
      context({ path: '/tmp/n.txt', old_string: 'notfound', new_string: 'replacement' }),
    );

    expect(result.isError).toBe(true);
    // Lockdown the negative side-effect: no write should have been issued.
    expect(writeText).not.toHaveBeenCalled();
  });

  it('errors with an is-not-a-file phrasing when the path resolves to a directory', async () => {
    // py wording is "is not a file"; TS currently relies on readText to fail.
    // fake-jian's notImplemented() defaults make this surface a generic
    // readText error today — fail-divergent until the path-type check moves
    // upstream of read.
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockRejectedValue(
          Object.assign(new Error('EISDIR: illegal operation on a directory'), {
            code: 'EISDIR',
          }),
        ),
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool,
      context({ path: '/tmp/dir', old_string: 'old', new_string: 'new' }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('is not a file');
  });

  it('replaces a substring with an empty new_string (deletion)', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('Hello world!'),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool,
      context({ path: '/tmp/e.txt', old_string: 'world', new_string: '' }),
    );

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(writeText).toHaveBeenCalledWith('/tmp/e.txt', 'Hello !');
  });

  it('allows absolute edits outside the workspace under default policy', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('old content'),
        writeText,
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool,
      context({ path: '/tmp/outside.txt', old_string: 'old', new_string: 'new' }),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/outside.txt', 'new content');
  });

  it('allows absolute edits to a sibling dir that merely shares the work-dir prefix', async () => {
    // /workspace-sneaky/* is outside /workspace — string prefix check must not
    // mistake "shares a prefix" for "inside workspace".
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('content'),
        writeText,
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool,
      context({ path: '/workspace-sneaky/test.txt', old_string: 'content', new_string: 'new' }),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/workspace-sneaky/test.txt', 'new');
  });

  it('fails the second concurrent edit when the first edit changed the anchor', async () => {
    let content = 'alpha beta';
    const writeText = vi.fn().mockImplementation(async (_path: string, newContent: string) => {
      content = newContent;
      return 0;
    });
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockImplementation(() => Promise.resolve(content)),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );
    const sharedAnchor = computeAnchor(toModelTextView(content).text);

    const first = await executeTool(
      tool,
      context({
        path: '/tmp/a.txt',
        old_string: 'beta',
        new_string: 'gamma',
        anchor: sharedAnchor,
      }),
    );
    expect(first.isError).toBeFalsy();
    expect(content).toBe('alpha gamma');

    const second = await executeTool(
      tool,
      context({
        path: '/tmp/a.txt',
        old_string: 'beta',
        new_string: 'delta',
        anchor: sharedAnchor,
      }),
    );
    expect(second.isError).toBe(true);
    expect(second.output).toContain('anchor no longer matches');
  });

  it('refuses to edit strictly inside an unresolved merge conflict block', async () => {
    const content = [
      'function foo() {',
      '<<<<<<< HEAD',
      '  return 1;',
      '=======',
      '  return 2;',
      '>>>>>>> branch',
      '}',
    ].join('\n');
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/conflict.ts',
        old_string: 'return 1;',
        new_string: 'return 0;',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('unresolved merge conflict');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('allows replacing the entire conflict block including markers', async () => {
    const content = [
      'function foo() {',
      '<<<<<<< HEAD',
      '  return 1;',
      '=======',
      '  return 2;',
      '>>>>>>> branch',
      '}',
    ].join('\n');
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/conflict.ts',
        old_string: '<<<<<<< HEAD\n  return 1;\n=======\n  return 2;\n>>>>>>> branch',
        new_string: '  return 3;',
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalled();
  });

  it('allows editing code outside a conflict block', async () => {
    const content = [
      'function foo() {',
      '<<<<<<< HEAD',
      '  return 1;',
      '=======',
      '  return 2;',
      '>>>>>>> branch',
      '}',
      'function bar() {',
      '  return 3;',
      '}',
    ].join('\n');
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/conflict.ts',
        old_string: 'return 3;',
        new_string: 'return 4;',
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalled();
  });

  it('refuses when new_string introduces complete merge conflict markers', async () => {
    const content = 'function foo() {\n  return 1;\n}\n';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/clean.ts',
        old_string: 'return 1;',
        new_string: '<<<<<<< HEAD\n  return 1;\n=======\n  return 2;\n>>>>>>> branch',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('new_string contains merge conflict markers');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('allows new_string with a lone marker that does not form a complete block', async () => {
    const content = 'function foo() {\n  return 1;\n}\n';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/clean.ts',
        old_string: 'return 1;',
        new_string: 'return 2; // <<<<<<< just a comment, not at column 0',
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalled();
  });

  it('marks isError when LSP reports error-severity diagnostics after edit', async () => {
    const errorDiag: LspDiagnostic = {
      range: { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } },
      severity: 1,
      message: 'Type error',
    };
    const registry = {
      getClient: vi.fn().mockResolvedValue({
        didOpen: vi.fn(),
        didChange: vi.fn(),
        diagnosticsReport: vi.fn().mockResolvedValue({ diagnostics: [errorDiag], observed: true }),
      }),
      languageIdForPath: vi.fn().mockReturnValue('typescript'),
      commandForPath: vi.fn().mockReturnValue(['typescript-language-server', '--stdio']),
      stopAll: vi.fn(),
    } as unknown as LspRegistry;

    const content = 'const x = 1;\n';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
      registry,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/a.ts',
        old_string: '1',
        new_string: '2',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Replaced 1 occurrence');
    expect(result.output).toContain('[LSP]');
    expect(result.output).toContain('Type error');
    expect(result.message).toBeUndefined();
  });

  it('does not mark isError when LSP reports only warnings', async () => {
    const warningDiag: LspDiagnostic = {
      range: { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } },
      severity: 2,
      message: 'Unused variable',
    };
    const registry = {
      getClient: vi.fn().mockResolvedValue({
        didOpen: vi.fn(),
        didChange: vi.fn(),
        diagnosticsReport: vi.fn().mockResolvedValue({ diagnostics: [warningDiag], observed: true }),
      }),
      languageIdForPath: vi.fn().mockReturnValue('typescript'),
      commandForPath: vi.fn().mockReturnValue(['typescript-language-server', '--stdio']),
      stopAll: vi.fn(),
    } as unknown as LspRegistry;

    const content = 'const x = 1;\n';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
      registry,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/a.ts',
        old_string: '1',
        new_string: '2',
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('[LSP]');
    expect(result.output).toContain('Unused variable');
    expect(result.message).toBeUndefined();
  });
});

describe('EditTool edit-recovery reminders', () => {
  const preExisting: LspDiagnostic = {
    range: { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } },
    severity: 1,
    message: 'Pre-existing error',
  };
  const introduced: LspDiagnostic = {
    range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
    severity: 1,
    message: 'Cannot find name x',
  };
  const TEXT = 'const x = 1;\n';

  /** Edit tool whose post-edit diagnostics observe `state.diagnostics` live. */
  function recoveryTool(
    queue: EditRecoveryQueue,
    state: { diagnostics: LspDiagnostic[]; supported?: boolean },
  ): EditTool {
    const registry = {
      getClient: vi.fn().mockResolvedValue({
        didOpen: vi.fn(),
        didChange: vi.fn(),
        diagnosticsReport: vi
          .fn()
          .mockImplementation(async () => ({ diagnostics: state.diagnostics, observed: true })),
      }),
      languageIdForPath: vi
        .fn()
        .mockImplementation(() => (state.supported === false ? undefined : 'typescript')),
      commandForPath: vi.fn().mockReturnValue(['typescript-language-server', '--stdio']),
      // Active client present: the pre-write baseline seed may run.
      activeClientFor: vi.fn().mockResolvedValue({}),
      stopAll: vi.fn(),
    } as unknown as LspRegistry;
    return new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(TEXT),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      PERMISSIVE_WORKSPACE,
      registry,
      undefined,
      undefined,
      queue,
    );
  }

  function edit(tool: EditTool, replacement: string) {
    return executeTool(
      tool,
      context({ path: '/tmp/a.ts', old_string: '1', new_string: replacement }),
    );
  }

  it('records the first observation of a file without queuing its pre-existing errors', async () => {
    const queue = new EditRecoveryQueue();
    const result = await edit(recoveryTool(queue, { diagnostics: [preExisting] }), '2');

    expect(result.isError).toBe(true);
    expect(queue.drain()).toEqual([]);
  });

  it('queues only the signature the edit introduced', async () => {
    const queue = new EditRecoveryQueue();
    const state = { diagnostics: [preExisting] };
    const tool = recoveryTool(queue, state);

    await edit(tool, '2');
    state.diagnostics = [preExisting, introduced];
    await edit(tool, '3');

    const [item] = queue.drain();
    expect(item?.displayPath).toBe('/tmp/a.ts');
    expect(item?.path).toBe('/tmp/a.ts');
    expect(item?.signatures).toEqual([
      { signature: '1:Cannot find name x:1', line: 2, message: 'Cannot find name x' },
    ]);
  });

  it('clears the reminder once a later observation no longer reports the error', async () => {
    const queue = new EditRecoveryQueue();
    const state = { diagnostics: [] as LspDiagnostic[] };
    const tool = recoveryTool(queue, state);

    await edit(tool, '2');
    state.diagnostics = [introduced];
    await edit(tool, '3');
    expect(queue.drain()).toHaveLength(1);

    state.diagnostics = [];
    await edit(tool, '4');
    expect(queue.drain()).toEqual([]);
  });

  it('does not duplicate a reminder when the same signature is still reported', async () => {
    const queue = new EditRecoveryQueue();
    const state = { diagnostics: [] as LspDiagnostic[] };
    const tool = recoveryTool(queue, state);

    await edit(tool, '2');
    state.diagnostics = [introduced];
    await edit(tool, '3');
    await edit(tool, '4');

    expect(queue.drain()).toHaveLength(1);
  });

  it('ignores warning-severity diagnostics', async () => {
    const queue = new EditRecoveryQueue();
    const state = { diagnostics: [] as LspDiagnostic[] };
    const tool = recoveryTool(queue, state);

    await edit(tool, '2');
    state.diagnostics = [{ ...introduced, severity: 2 }];
    await edit(tool, '3');

    expect(queue.drain()).toEqual([]);
  });

  it('ignores fetches where the language server is unavailable', async () => {
    const queue = new EditRecoveryQueue();
    const state: { diagnostics: LspDiagnostic[]; supported?: boolean } = {
      diagnostics: [],
      supported: false,
    };
    const tool = recoveryTool(queue, state);

    // Unsupported file type: the empty result is "no observation", not "the
    // file is clean" — it must not prime the baseline.
    await edit(tool, '2');
    state.supported = true;
    state.diagnostics = [introduced];
    await edit(tool, '3');

    expect(queue.drain()).toEqual([]);
  });

  it('tracks range edits the same way as string edits', async () => {
    const queue = new EditRecoveryQueue();
    const state = { diagnostics: [] as LspDiagnostic[] };
    const tool = recoveryTool(queue, state);
    const anchor = computeAnchor(TEXT);
    const rangeEdit = (text: string) =>
      executeTool(
        tool,
        context({ path: '/tmp/a.ts', start_line: 1, end_line: 1, new_string: text, anchor }),
      );

    await rangeEdit('const y = 1;');
    state.diagnostics = [introduced];
    await rangeEdit('const z = 1;');

    expect(queue.drain()).toHaveLength(1);
  });
});

describe('EditTool pre-write reminder baseline', () => {
  const introduced: LspDiagnostic = {
    range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
    severity: 1,
    message: 'Cannot find name x',
  };
  const preExisting: LspDiagnostic = {
    range: { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } },
    severity: 1,
    message: 'Pre-existing error',
  };
  const TEXT = 'const x = 1;\n';

  type Observation = LspDiagnostic[] | { diagnostics: LspDiagnostic[]; observed: boolean };

  /**
   * Edit tool whose diagnostics observations come from a script. Each call to
   * `diagnosticsReport` (pre-write seed first, then the post-write fetch)
   * consumes the next entry; the last entry repeats.
   */
  function scriptedTool(
    queue: EditRecoveryQueue,
    observations: readonly Observation[],
    hasActiveClient: boolean,
  ): { tool: EditTool; report: ReturnType<typeof vi.fn> } {
    let call = 0;
    const report = vi.fn().mockImplementation(async () => {
      const next = observations[Math.min(call, observations.length - 1)] ?? [];
      call += 1;
      return Array.isArray(next) ? { diagnostics: next, observed: true } : next;
    });
    const client = { didOpen: vi.fn(), didChange: vi.fn(), diagnosticsReport: report };
    const registry = {
      getClient: vi.fn().mockResolvedValue(client),
      languageIdForPath: vi.fn().mockReturnValue('typescript'),
      commandForPath: vi.fn().mockReturnValue(['typescript-language-server', '--stdio']),
      activeClientFor: vi.fn().mockResolvedValue(hasActiveClient ? client : undefined),
      stopAll: vi.fn(),
    } as unknown as LspRegistry;
    return {
      tool: new EditTool(
        createFakeJian({
          readText: vi.fn().mockResolvedValue(TEXT),
          writeText: vi.fn().mockResolvedValue(0),
        }),
        PERMISSIVE_WORKSPACE,
        registry,
        undefined,
        undefined,
        queue,
      ),
      report,
    };
  }

  function edit(tool: EditTool, replacement: string) {
    return executeTool(
      tool,
      context({ path: '/tmp/a.ts', old_string: '1', new_string: replacement }),
    );
  }

  it('queues a reminder for an error the FIRST edit of a file introduces', async () => {
    const queue = new EditRecoveryQueue();
    const { tool, report } = scriptedTool(queue, [[], [introduced]], true);

    await edit(tool, '2');

    // Two observations: one before the write (the seed) and one after it.
    expect(report).toHaveBeenCalledTimes(2);
    expect(queue.drain()).toHaveLength(1);
    expect(queue.drain()[0]?.signatures).toEqual([
      { signature: '1:Cannot find name x:1', line: 2, message: 'Cannot find name x' },
    ]);
  });

  it('does not queue an error the file already had before the first edit', async () => {
    const queue = new EditRecoveryQueue();
    const { tool } = scriptedTool(queue, [[preExisting], [preExisting]], true);

    await edit(tool, '2');

    expect(queue.drain()).toEqual([]);
  });

  it('pre-observes the first edit even when no client is warm yet', async () => {
    const queue = new EditRecoveryQueue();
    // No warm client: the pre-write fetch cold-starts the same language
    // server the post-write fetch would start anyway, so the seed happens.
    const { tool, report } = scriptedTool(queue, [[], [introduced]], false);

    await edit(tool, '2');

    expect(report).toHaveBeenCalledTimes(2);
    expect(queue.drain()).toHaveLength(1);
  });

  it('leaves the baseline unset when the pre-write observation is not observed', async () => {
    const queue = new EditRecoveryQueue();
    const { tool } = scriptedTool(
      queue,
      [{ diagnostics: [], observed: false }, [introduced]],
      false,
    );

    await edit(tool, '2');

    // An unobserved pre-fetch is not a clean baseline: nothing is queued.
    expect(queue.drain()).toEqual([]);
  });

  it('treats a timed-out observation as no observation at all', async () => {
    const queue = new EditRecoveryQueue();
    const { tool } = scriptedTool(
      queue,
      [[], [introduced], { diagnostics: [], observed: false }, []],
      true,
    );

    await edit(tool, '2');
    expect(queue.drain()).toHaveLength(1);

    // The poll timed out: neither the baseline nor the reminder may move.
    await edit(tool, '3');
    expect(queue.drain()).toHaveLength(1);

    // A real observation of a clean file resolves the reminder.
    await edit(tool, '4');
    expect(queue.drain()).toEqual([]);
  });
});

describe('EditTool replace_range', () => {
  it('keeps the two edit modes exclusive at the schema level', () => {
    const parse = (args: Record<string, unknown>) => EditInputSchema.safeParse(args);

    // replace_range: both fields together, anchor required, old_string and
    // replace_all excluded.
    expect(
      parse({ path: '/tmp/a.txt', new_string: 'x', start_line: 2, end_line: 2, anchor: 'aaaaaaaa' })
        .success,
    ).toBe(true);
    expect(
      parse({ path: '/tmp/a.txt', new_string: 'x', end_line: 2, anchor: 'aaaaaaaa' }).success,
    ).toBe(false);
    expect(
      parse({ path: '/tmp/a.txt', new_string: 'x', start_line: 2, anchor: 'aaaaaaaa' }).success,
    ).toBe(false);
    expect(
      parse({
        path: '/tmp/a.txt',
        old_string: 'x',
        new_string: 'y',
        start_line: 1,
        end_line: 2,
        anchor: 'aaaaaaaa',
      }).success,
    ).toBe(false);
    expect(
      parse({
        path: '/tmp/a.txt',
        new_string: 'y',
        start_line: 1,
        end_line: 2,
        replace_all: true,
        anchor: 'aaaaaaaa',
      }).success,
    ).toBe(false);
    expect(
      parse({ path: '/tmp/a.txt', new_string: 'y', start_line: 3, end_line: 2, anchor: 'aaaaaaaa' })
        .success,
    ).toBe(false);
    expect(
      parse({ path: '/tmp/a.txt', new_string: 'y', start_line: 0, end_line: 2, anchor: 'aaaaaaaa' })
        .success,
    ).toBe(false);
    expect(
      parse({
        path: '/tmp/a.txt',
        new_string: 'y',
        start_line: 1.5,
        end_line: 2,
        anchor: 'aaaaaaaa',
      }).success,
    ).toBe(false);

    // old_string mode still requires old_string.
    expect(parse({ path: '/tmp/a.txt', new_string: 'y' }).success).toBe(false);
  });

  it('carries dedicated messages for the mode rules it enforces', () => {
    const messagesOf = (args: Record<string, unknown>): string[] => {
      const parsed = EditInputSchema.safeParse(args);
      if (parsed.success) throw new Error('expected schema rejection');
      return parsed.error.issues.map((issue) => issue.message);
    };

    const missingAnchor = messagesOf({
      path: '/tmp/a.txt',
      new_string: 'y',
      start_line: 1,
      end_line: 2,
    });
    expect(missingAnchor).toContain(
      'Line-range edits require the anchor from the most recent Read of this file — line numbers are only meaningful against that snapshot.',
    );

    const modeMix = messagesOf({
      path: '/tmp/a.txt',
      old_string: 'x',
      new_string: 'y',
      start_line: 1,
      end_line: 2,
      anchor: 'aaaaaaaa',
    });
    expect(
      modeMix.some((message) =>
        message.startsWith('old_string must be omitted when start_line/end_line'),
      ),
    ).toBe(true);

    const halfRange = messagesOf({
      path: '/tmp/a.txt',
      new_string: 'y',
      start_line: 2,
      anchor: 'aaaaaaaa',
    });
    expect(halfRange).toContain('start_line and end_line must be provided together.');

    const reversed = messagesOf({
      path: '/tmp/a.txt',
      new_string: 'y',
      start_line: 3,
      end_line: 2,
      anchor: 'aaaaaaaa',
    });
    expect(
      reversed.some((message) => message.startsWith('start_line (3) must not exceed end_line (2)')),
    ).toBe(true);
  });

  it('replaces a multi-line window by range', async () => {
    const content = 'one\ntwo\nthree\nfour\n';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/range.txt',
        new_string: 'TWO\nTHREE',
        start_line: 2,
        end_line: 3,
        anchor: computeAnchor(toModelTextView(content).text),
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Replaced lines 2-3 in /tmp/range.txt');
    expect(writeText).toHaveBeenCalledWith('/tmp/range.txt', 'one\nTWO\nTHREE\nfour\n');
  });

  it('replaces a single line when start_line equals end_line', async () => {
    const content = 'one\ntwo\nthree\n';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/single.txt',
        new_string: 'two!',
        start_line: 2,
        end_line: 2,
        anchor: computeAnchor(toModelTextView(content).text),
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Replaced line 2 in /tmp/single.txt');
    expect(writeText).toHaveBeenCalledWith('/tmp/single.txt', 'one\ntwo!\nthree\n');
  });

  it('deletes a line window with an empty new_string', async () => {
    const content = 'one\ntwo\nthree\nfour\n';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/delete.txt',
        new_string: '',
        start_line: 2,
        end_line: 3,
        anchor: computeAnchor(toModelTextView(content).text),
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Replaced lines 2-3 in /tmp/delete.txt');
    expect(writeText).toHaveBeenCalledWith('/tmp/delete.txt', 'one\nfour\n');
  });

  it('can empty the file by replacing the whole range with an empty new_string', async () => {
    const content = 'one\ntwo\n';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/whole.txt',
        new_string: '',
        start_line: 1,
        end_line: 2,
        anchor: computeAnchor(toModelTextView(content).text),
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/whole.txt', '');
  });

  it('preserves the trailing-newline convention the file already had', async () => {
    // No trailing newline in the source: none may appear in the result.
    const content = 'one\ntwo\nthree';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/notrail.txt',
        new_string: 'TWO',
        start_line: 2,
        end_line: 2,
        anchor: computeAnchor(toModelTextView(content).text),
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/notrail.txt', 'one\nTWO\nthree');
  });

  it('rejects a range past the end of the file, naming the actual line count', async () => {
    const content = 'one\ntwo\n';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/range.txt',
        new_string: 'x',
        start_line: 1,
        end_line: 3,
        anchor: computeAnchor(toModelTextView(content).text),
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('file has 2 lines');
    expect(result.output).toContain('requested lines 1-3');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects any range against an empty file', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(''),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/empty.txt',
        new_string: 'x',
        start_line: 1,
        end_line: 1,
        anchor: computeAnchor(''),
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('file has 0 lines');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('still hard-rejects on an anchor mismatch in range mode', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('one\ntwo\n'),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/stale.txt',
        new_string: 'x',
        start_line: 2,
        end_line: 2,
        anchor: 'badbadbad',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('anchor no longer matches');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('numbers CRLF files by their LF model view and writes back CRLF', async () => {
    const content = 'alpha\r\nbravo\r\ncharlie\r\n';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/crlf.txt',
        new_string: 'bravo2',
        start_line: 2,
        end_line: 2,
        anchor: computeAnchor(toModelTextView(content).text),
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/crlf.txt', 'alpha\r\nbravo2\r\ncharlie\r\n');
  });

  it('keeps CRLF output when the file has no trailing newline', async () => {
    const content = 'alpha\r\nbravo\r\ncharlie';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/crlf-noend.txt',
        new_string: '',
        start_line: 3,
        end_line: 3,
        anchor: computeAnchor(toModelTextView(content).text),
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/crlf-noend.txt', 'alpha\r\nbravo');
  });

  it('keeps mixed line endings on untouched lines in range mode', async () => {
    const content = 'alpha\r\nbeta\ngamma\r\n';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/mixed.txt',
        new_string: 'beta2',
        start_line: 2,
        end_line: 2,
        anchor: computeAnchor(toModelTextView(content).text),
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/mixed.txt', 'alpha\r\nbeta2\ngamma\r\n');
  });

  it('rejects mode mixing before file I/O when the schema is bypassed', async () => {
    const readText = vi.fn().mockResolvedValue('one\ntwo\n');
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(createFakeJian({ readText, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/a.txt',
        old_string: 'one',
        new_string: 'x',
        start_line: 1,
        end_line: 1,
        anchor: 'aaaaaaaa',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('the two modes are exclusive');
    expect(readText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects replace_all with a line range before file I/O', async () => {
    const readText = vi.fn().mockResolvedValue('one\ntwo\n');
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(createFakeJian({ readText, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/a.txt',
        new_string: 'x',
        start_line: 1,
        end_line: 1,
        replace_all: true,
        anchor: 'aaaaaaaa',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('replace_all has no effect with start_line/end_line');
    expect(readText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects a line range without an anchor before file I/O', async () => {
    const readText = vi.fn().mockResolvedValue('one\ntwo\n');
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(createFakeJian({ readText, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/a.txt',
        new_string: 'x',
        start_line: 1,
        end_line: 1,
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('require the anchor from the most recent Read');
    expect(readText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects a reversed range before file I/O', async () => {
    const readText = vi.fn().mockResolvedValue('one\ntwo\n');
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(createFakeJian({ readText, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/a.txt',
        new_string: 'x',
        start_line: 3,
        end_line: 2,
        anchor: 'aaaaaaaa',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('must not exceed end_line');
    expect(readText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects a half-specified range before file I/O', async () => {
    const readText = vi.fn().mockResolvedValue('one\ntwo\n');
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(createFakeJian({ readText, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/a.txt',
        new_string: 'x',
        start_line: 2,
        anchor: 'aaaaaaaa',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('must be provided together');
    expect(readText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('refuses a range strictly inside an unresolved merge conflict block', async () => {
    const content = [
      'function foo() {',
      '<<<<<<< HEAD',
      '  return 1;',
      '=======',
      '  return 2;',
      '>>>>>>> branch',
      '}',
    ].join('\n');
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/conflict.ts',
        new_string: '  return 0;',
        start_line: 3,
        end_line: 5,
        anchor: computeAnchor(toModelTextView(content).text),
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('fall inside unresolved merge conflict markers');
    expect(result.output).toContain('lines 2-6');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('allows a range that covers the entire conflict block including markers', async () => {
    const content = [
      'function foo() {',
      '<<<<<<< HEAD',
      '  return 1;',
      '=======',
      '  return 2;',
      '>>>>>>> branch',
      '}',
    ].join('\n');
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/conflict.ts',
        new_string: '  return 3;',
        start_line: 2,
        end_line: 6,
        anchor: computeAnchor(toModelTextView(content).text),
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/conflict.ts', 'function foo() {\n  return 3;\n}');
  });

  it('appends the LSP diagnostics notice after a range edit', async () => {
    const errorDiag: LspDiagnostic = {
      range: { start: { line: 1, character: 5 }, end: { line: 1, character: 10 } },
      severity: 1,
      message: 'Type error',
    };
    const registry = {
      getClient: vi.fn().mockResolvedValue({
        didOpen: vi.fn(),
        didChange: vi.fn(),
        diagnosticsReport: vi.fn().mockResolvedValue({ diagnostics: [errorDiag], observed: true }),
      }),
      languageIdForPath: vi.fn().mockReturnValue('typescript'),
      commandForPath: vi.fn().mockReturnValue(['typescript-language-server', '--stdio']),
      stopAll: vi.fn(),
    } as unknown as LspRegistry;

    const content = 'const x = 1;\nconst y = 2;\n';
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
      registry,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/a.ts',
        new_string: 'const y = 20;',
        start_line: 2,
        end_line: 2,
        anchor: computeAnchor(toModelTextView(content).text),
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Replaced line 2 in /tmp/a.ts');
    expect(result.output).toContain('[LSP]');
    expect(result.output).toContain('Type error');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.ts', 'const x = 1;\nconst y = 20;\n');
    expect(result.message).toBeUndefined();
  });
});

describe('EditTool noop-loop-guard', () => {
  const NOOP_PATHS = ['/tmp/noop-a.txt', '/tmp/noop-b.txt', '/tmp/noop-c.txt', '/tmp/noop-range.txt'];

  beforeEach(() => {
    for (const p of NOOP_PATHS) resetNoopLoop(p);
  });

  afterEach(() => {
    for (const p of NOOP_PATHS) resetNoopLoop(p);
  });

  function asError(r: { isError?: boolean }): { stopTurn?: boolean; output: unknown } {
    if (r.isError !== true) throw new Error('expected error result');
    return r as { stopTurn?: boolean; output: unknown };
  }

  it('stops the turn after 3 consecutive identical failed edits', async () => {
    resetNoopLoop('/tmp/noop-a.txt');
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('alpha beta'),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      PERMISSIVE_WORKSPACE,
    );

    const args: EditInput = {
      path: '/tmp/noop-a.txt',
      old_string: 'missing',
      new_string: 'whatever',
    };

    const r1 = await executeTool(tool, context(args));
    expect(r1.isError).toBe(true);
    expect(asError(r1).stopTurn).toBeUndefined();

    const r2 = await executeTool(tool, context(args));
    expect(r2.isError).toBe(true);
    expect(asError(r2).stopTurn).toBeUndefined();
    expect(r2.output).toContain('Warning: attempt 2 of 3');

    const r3 = await executeTool(tool, context(args));
    expect(r3.isError).toBe(true);
    expect(asError(r3).stopTurn).toBe(true);
    expect(r3.output).toContain('stuck in a loop');
    resetNoopLoop('/tmp/noop-a.txt');
  });

  it('resets the counter after a successful edit', async () => {
    resetNoopLoop('/tmp/noop-b.txt');
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('alpha beta'),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      PERMISSIVE_WORKSPACE,
    );

    const failArgs: EditInput = {
      path: '/tmp/noop-b.txt',
      old_string: 'missing',
      new_string: 'whatever',
    };
    const r1 = await executeTool(tool, context(failArgs));
    expect(r1.isError).toBe(true);
    expect(asError(r1).stopTurn).toBeUndefined();

    const successArgs: EditInput = {
      path: '/tmp/noop-b.txt',
      old_string: 'beta',
      new_string: 'gamma',
    };
    const r2 = await executeTool(tool, context(successArgs));
    expect(r2.isError).toBeFalsy();

    const r3 = await executeTool(tool, context(failArgs));
    expect(r3.isError).toBe(true);
    expect(asError(r3).stopTurn).toBeUndefined();
    expect(r3.output).not.toContain('Warning: attempt');
    resetNoopLoop('/tmp/noop-b.txt');
  });

  it('does not trip when failures use different payloads', async () => {
    resetNoopLoop('/tmp/noop-c.txt');
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('alpha beta'),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      PERMISSIVE_WORKSPACE,
    );

    const r1 = await executeTool(
      tool,
      context({
        path: '/tmp/noop-c.txt',
        old_string: 'missing-one',
        new_string: 'a',
      }),
    );
    expect(r1.isError).toBe(true);
    expect(asError(r1).stopTurn).toBeUndefined();

    const r2 = await executeTool(
      tool,
      context({
        path: '/tmp/noop-c.txt',
        old_string: 'missing-two',
        new_string: 'b',
      }),
    );
    expect(r2.isError).toBe(true);
    expect(asError(r2).stopTurn).toBeUndefined();
    expect(r2.output).not.toContain('Warning: attempt');
    resetNoopLoop('/tmp/noop-c.txt');
  });

  it('warns on the second identical failed range edit and stops at the limit', async () => {
    resetNoopLoop('/tmp/noop-range.txt');
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('one\ntwo\n'),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      PERMISSIVE_WORKSPACE,
    );

    const args: EditInput = {
      path: '/tmp/noop-range.txt',
      new_string: 'x',
      start_line: 2,
      end_line: 2,
      anchor: 'badbadbad',
    };

    const r1 = await executeTool(tool, context(args));
    expect(r1.isError).toBe(true);
    expect(asError(r1).stopTurn).toBeUndefined();
    expect(r1.output).not.toContain('Warning: attempt');

    const r2 = await executeTool(tool, context(args));
    expect(r2.isError).toBe(true);
    expect(asError(r2).stopTurn).toBeUndefined();
    expect(r2.output).toContain('Warning: attempt 2 of 3');

    const r3 = await executeTool(tool, context(args));
    expect(r3.isError).toBe(true);
    expect(asError(r3).stopTurn).toBe(true);
    expect(r3.output).toContain('stuck in a loop');
    resetNoopLoop('/tmp/noop-range.txt');
  });

  it('treats range edits over different windows as different payloads', async () => {
    resetNoopLoop('/tmp/noop-range.txt');
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('one\ntwo\n'),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      PERMISSIVE_WORKSPACE,
    );

    const r1 = await executeTool(
      tool,
      context({
        path: '/tmp/noop-range.txt',
        new_string: 'x',
        start_line: 1,
        end_line: 1,
        anchor: 'badbadbad',
      }),
    );
    expect(r1.isError).toBe(true);
    expect(asError(r1).stopTurn).toBeUndefined();

    // A different window hashes differently, so the failure counter restarts.
    const r2 = await executeTool(
      tool,
      context({
        path: '/tmp/noop-range.txt',
        new_string: 'x',
        start_line: 1,
        end_line: 2,
        anchor: 'badbadbad',
      }),
    );
    expect(r2.isError).toBe(true);
    expect(asError(r2).stopTurn).toBeUndefined();
    expect(r2.output).not.toContain('Warning: attempt');
    resetNoopLoop('/tmp/noop-range.txt');
  });
});

describe('EditTool file_diff display', () => {
  // These tests run against real files on disk (LocalJian) so the reported
  // counts are checked against the true before/after contents rather than
  // against the tool's own bookkeeping.
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scream-edit-diff-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports one added and one removed line for a single-line replacement', async () => {
    const path = join(dir, 'single.ts');
    const before = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
    await writeFile(path, before, 'utf8');
    const tool = new EditTool(testJian, PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({ path, old_string: 'const b = 2;', new_string: 'const b = 20;' }),
    );

    expect(result.isError).toBeFalsy();
    if (result.isError === true) throw new Error('expected success result');
    const after = await readFile(path, 'utf8');
    expect(after).toBe('const a = 1;\nconst b = 20;\nconst c = 3;\n');
    expect(fileDiffSummary(before, after)).toEqual({ added: 1, removed: 1 });
    expect(result.display).toEqual({ kind: 'file_diff', added: 1, removed: 1 });
  });

  it('counts every occurrence for replace_all instead of a single replacement', async () => {
    const path = join(dir, 'replace-all.ts');
    // Three occurrences of OLD, so a single-occurrence count would report 1/1.
    const before = 'const a = OLD;\nconst b = OLD;\nconst c = OLD;\n';
    await writeFile(path, before, 'utf8');
    const tool = new EditTool(testJian, PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({ path, old_string: 'OLD', new_string: 'NEW', replace_all: true }),
    );

    expect(result.isError).toBeFalsy();
    if (result.isError === true) throw new Error('expected success result');
    const after = await readFile(path, 'utf8');
    expect(after).toBe('const a = NEW;\nconst b = NEW;\nconst c = NEW;\n');
    expect(fileDiffSummary(before, after)).toEqual({ added: 3, removed: 3 });
    expect(result.display).toEqual({ kind: 'file_diff', added: 3, removed: 3 });
  });

  it('diffs the text actually written for a CRLF file', async () => {
    const path = join(dir, 'crlf.txt');
    const before = 'alpha\r\nbravo\r\ncharlie\r\n';
    await writeFile(path, before, 'utf8');
    const tool = new EditTool(testJian, PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({ path, old_string: 'bravo', new_string: 'bravo\nbravo2' }),
    );

    expect(result.isError).toBeFalsy();
    if (result.isError === true) throw new Error('expected success result');
    const after = await readFile(path, 'utf8');
    expect(after).toBe('alpha\r\nbravo\r\nbravo2\r\ncharlie\r\n');
    expect(fileDiffSummary(before, after)).toEqual({ added: 1, removed: 0 });
    expect(result.display).toEqual({ kind: 'file_diff', added: 1, removed: 0 });
  });

  it('reports the whole-file delta when the edit rewrites many lines', async () => {
    const path = join(dir, 'bulk.ts');
    const before = 'one\ntwo\nthree\nfour\nfive\n';
    await writeFile(path, before, 'utf8');
    const tool = new EditTool(testJian, PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({ path, old_string: 'two\nthree\nfour', new_string: 'TWO' }),
    );

    expect(result.isError).toBeFalsy();
    if (result.isError === true) throw new Error('expected success result');
    const after = await readFile(path, 'utf8');
    expect(after).toBe('one\nTWO\nfive\n');
    expect(fileDiffSummary(before, after)).toEqual({ added: 1, removed: 3 });
    expect(result.display).toEqual({ kind: 'file_diff', added: 1, removed: 3 });
  });

  it('omits the display when the edit fails', async () => {
    const path = join(dir, 'untouched.txt');
    await writeFile(path, 'alpha beta\n', 'utf8');
    const tool = new EditTool(testJian, PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({ path, old_string: 'not in the file', new_string: 'x' }),
    );

    expect(result.isError).toBe(true);
    expect(Object.keys(result)).not.toContain('display');
    expect(await readFile(path, 'utf8')).toBe('alpha beta\n');
  });

  it('omits the display when the file is too large to diff', async () => {
    // A file past the size guard still edits; only the display is dropped and
    // the UI falls back to its argument-derived counts.
    const path = join(dir, 'huge.txt');
    const before = `${'x'.repeat(1_000_001)}\nUNIQUE-MARKER\n`;
    await writeFile(path, before, 'utf8');
    const tool = new EditTool(testJian, PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({ path, old_string: 'UNIQUE-MARKER', new_string: 'REPLACED' }),
    );

    expect(result.isError).toBeFalsy();
    expect(Object.keys(result)).not.toContain('display');
    expect(await readFile(path, 'utf8')).not.toBe(before);
  });

  it('reports the real line delta for a range replacement', async () => {
    const path = join(dir, 'range.ts');
    const before = 'one\ntwo\nthree\nfour\nfive\n';
    await writeFile(path, before, 'utf8');
    const tool = new EditTool(testJian, PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({
        path,
        new_string: 'X',
        start_line: 2,
        end_line: 4,
        anchor: computeAnchor(before),
      }),
    );

    expect(result.isError).toBeFalsy();
    if (result.isError === true) throw new Error('expected success result');
    const after = await readFile(path, 'utf8');
    expect(after).toBe('one\nX\nfive\n');
    expect(fileDiffSummary(before, after)).toEqual({ added: 1, removed: 3 });
    expect(result.display).toEqual({ kind: 'file_diff', added: 1, removed: 3 });
  });
});

describe('EditTool stale-read warning', () => {
  it('warns when the target was not read recently and no anchor is passed', async () => {
    const content = 'const x = 1;\n';
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      PERMISSIVE_WORKSPACE,
      undefined,
      new WorkingSet(),
    );

    const result = await executeTool(
      tool,
      context({ path: '/tmp/stale.ts', old_string: '1', new_string: '2' }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('no recent read of /tmp/stale.ts was found in this session');
  });

  it('does not warn when the file was recently read', async () => {
    const content = 'const x = 1;\n';
    const workingSet = new WorkingSet();
    workingSet.markRead('/tmp/fresh.ts', 1);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      PERMISSIVE_WORKSPACE,
      undefined,
      workingSet,
    );

    const result = await executeTool(
      tool,
      context({ path: '/tmp/fresh.ts', old_string: '1', new_string: '2' }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain('no recent read');
  });

  it('does not warn when an anchor is supplied (proof of a fresh read)', async () => {
    const content = 'const x = 1;\n';
    const anchor = computeAnchor(toModelTextView(content).text);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      PERMISSIVE_WORKSPACE,
      undefined,
      new WorkingSet(),
    );

    const result = await executeTool(
      tool,
      context({ path: '/tmp/anchor.ts', old_string: '1', new_string: '2', anchor }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain('no recent read');
  });

  it('stays silent when no working set is wired (standalone construction)', async () => {
    const content = 'const x = 1;\n';
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({ path: '/tmp/standalone.ts', old_string: '1', new_string: '2' }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain('no recent read');
  });
});

describe('EditTool stale-anchor recovery', () => {
  /** Paths this block touches; each failure feeds the session noop-loop guard. */
  const RECOVERY_PATHS = [
    '/tmp/recover-insert.txt',
    '/tmp/recover-after.txt',
    '/tmp/recover-before.txt',
    '/tmp/recover-overlap.txt',
    '/tmp/recover-conflict-clean.txt',
    '/tmp/recover-conflict-trap.txt',
    '/tmp/recover-empty-store.txt',
    '/tmp/recover-no-store.txt',
    '/tmp/recover-str.txt',
    '/tmp/recover-anchor.txt',
    '/tmp/recover-rollback.ts',
    '/tmp/recover-stable.ts',
    '/tmp/recover-no-client.ts',
    '/tmp/recover-edit-snap.txt',
  ];

  afterEach(() => {
    for (const p of RECOVERY_PATHS) resetNoopLoop(p);
  });

  function readSnapshotOf(content: string): { content: string; anchor: string } {
    return { content, anchor: computeAnchor(toModelTextView(content).text) };
  }

  function toolWithStore(
    changedContent: string,
    store: EditSnapshotStore,
    writeText = vi.fn().mockResolvedValue(0),
    lspRegistry?: LspRegistry,
  ) {
    return {
      tool: new EditTool(
        createFakeJian({
          readText: vi.fn().mockResolvedValue(changedContent),
          writeText,
        }),
        PERMISSIVE_WORKSPACE,
        lspRegistry,
        undefined,
        store,
      ),
      writeText,
    };
  }

  /**
   * Registry whose single fake client returns one diagnostics array per
   * fetch, in order (call 1 = recovery pre-check, call 2 = post-apply check,
   * then the last array repeats).
   */
  function recoveryRegistry(diagnostics: LspDiagnostic[][]): LspRegistry {
    let call = 0;
    const fakeClient = {
      didOpen: vi.fn(),
      didChange: vi.fn(),
      diagnosticsReport: vi.fn().mockImplementation(async () => {
        const next = diagnostics[Math.min(call, diagnostics.length - 1)] ?? [];
        call += 1;
        return { diagnostics: next, observed: true };
      }),
    };
    return {
      activeClientFor: vi.fn().mockResolvedValue(fakeClient),
      getClient: vi.fn().mockResolvedValue(fakeClient),
      languageIdForPath: vi.fn().mockReturnValue('typescript'),
      commandForPath: vi.fn().mockReturnValue(['fake-lsp', '--stdio']),
      stopAll: vi.fn(),
    } as unknown as LspRegistry;
  }

  function errorDiagnostics(count: number): LspDiagnostic[] {
    return Array.from({ length: count }, (_, index) => ({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 1,
      message: `Error ${String(index)}`,
    }));
  }

  it('remaps a window across an external insertion above it and applies the shifted range', async () => {
    const read = 'one\ntwo\nthree\nfour\n';
    const changed = 'ZERO-A\nZERO-B\none\ntwo\nthree\nfour\n';
    const store = new EditSnapshotStore();
    store.remember('/tmp/recover-insert.txt', { ...readSnapshotOf(read), recordedAt: 'read' });
    const { tool, writeText } = toolWithStore(changed, store);

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/recover-insert.txt',
        new_string: 'TWO-NEW',
        start_line: 2,
        end_line: 3,
        anchor: readSnapshotOf(read).anchor,
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/recover-insert.txt', 'ZERO-A\nZERO-B\none\nTWO-NEW\nfour\n');
    expect(result.output).toContain('Replaced lines 4-5 in /tmp/recover-insert.txt');
    expect(result.output).toContain(
      'your line range was remapped (snapshot lines 2-3 → current lines 4-5)',
    );
    // The post-edit snapshot is recorded for the next stale-anchor attempt.
    const after = store.recall('/tmp/recover-insert.txt');
    expect(after?.recordedAt).toBe('edit');
    expect(after?.content).toBe('ZERO-A\nZERO-B\none\nTWO-NEW\nfour\n');
  });

  it('recovers when the external change sits after the window', async () => {
    const read = 'one\ntwo\nthree\n';
    const changed = 'one\ntwo\nthree\nAPPEND-A\nAPPEND-B\n';
    const store = new EditSnapshotStore();
    store.remember('/tmp/recover-after.txt', { ...readSnapshotOf(read), recordedAt: 'read' });
    const { tool, writeText } = toolWithStore(changed, store);

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/recover-after.txt',
        new_string: 'TWO',
        start_line: 2,
        end_line: 2,
        anchor: readSnapshotOf(read).anchor,
      }),
    );

    expect(result.isError).toBeFalsy();
    // The appended external lines are preserved.
    expect(writeText).toHaveBeenCalledWith('/tmp/recover-after.txt', 'one\nTWO\nthree\nAPPEND-A\nAPPEND-B\n');
    expect(result.output).toContain('Replaced line 2 in /tmp/recover-after.txt');
    expect(result.output).toContain(
      'your line range was remapped (snapshot lines 2-2 → current lines 2-2)',
    );
  });

  it('recovers when the external change sits before the window', async () => {
    const read = 'one\ntwo\nthree\nfour\n';
    const changed = 'two\nthree\nfour\n';
    const store = new EditSnapshotStore();
    store.remember('/tmp/recover-before.txt', { ...readSnapshotOf(read), recordedAt: 'read' });
    const { tool, writeText } = toolWithStore(changed, store);

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/recover-before.txt',
        new_string: 'X',
        start_line: 3,
        end_line: 4,
        anchor: readSnapshotOf(read).anchor,
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/recover-before.txt', 'two\nX\n');
    expect(result.output).toContain('Replaced lines 2-3 in /tmp/recover-before.txt');
  });

  it('applies a remapped window that clears a conflict block the stale numbers fall inside', async () => {
    // The model's window sits just below a conflict block in its view; an
    // external insert above the file moves the block onto the stale
    // coordinates. The stale-coordinate overlap used to refuse (false
    // reject), although the remapped window lands below the moved block and
    // the write is clean.
    const readLines = [
      'function foo() {',
      '<<<<<<< HEAD',
      '  return 1;',
      '=======',
      '  return 2;',
      '>>>>>>> branch',
      '}',
      'function bar() {',
      '  return 3;',
      '}',
    ];
    const read = readLines.join('\n') + '\n';
    const filler = Array.from({ length: 5 }, (_, index) => `// filler ${String(index + 1)}`);
    const changed = [...filler, ...readLines].join('\n') + '\n';
    const store = new EditSnapshotStore();
    store.remember('/tmp/recover-conflict-clean.txt', { ...readSnapshotOf(read), recordedAt: 'read' });
    const { tool, writeText } = toolWithStore(changed, store);

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/recover-conflict-clean.txt',
        new_string: 'function bar() {\n  return 4;',
        start_line: 8,
        end_line: 9,
        anchor: readSnapshotOf(read).anchor,
      }),
    );

    expect(result.isError).toBeFalsy();
    const written = [
      ...filler,
      'function foo() {',
      '<<<<<<< HEAD',
      '  return 1;',
      '=======',
      '  return 2;',
      '>>>>>>> branch',
      '}',
      'function bar() {',
      '  return 4;',
      '}',
    ].join('\n') + '\n';
    expect(writeText).toHaveBeenCalledWith('/tmp/recover-conflict-clean.txt', written);
    expect(result.output).toContain(
      'your line range was remapped (snapshot lines 8-9 → current lines 13-14)',
    );
    expect(store.recall('/tmp/recover-conflict-clean.txt')?.recordedAt).toBe('edit');
  });

  it('refuses a remapped window that lands strictly inside an externally moved conflict block', async () => {
    // The model's window sits strictly inside the conflict block of its
    // view; the external change removes three block lines above it, so the
    // block shrinks onto the remapped coordinates. The stale-coordinate
    // check passes (the original window no longer sits strictly inside the
    // moved block), but the window actually written would land between the
    // markers — the final-coordinate check must refuse.
    const readLines = [
      '<<<<<<< HEAD',
      '  alpha',
      '  beta',
      '  gamma',
      '  delta',
      '=======',
      '  omega',
      '>>>>>>> branch',
      'tail',
    ];
    const read = readLines.join('\n') + '\n';
    const changed = [
      '<<<<<<< HEAD',
      '  delta',
      '=======',
      '  omega',
      '>>>>>>> branch',
      'tail',
    ].join('\n') + '\n';
    const store = new EditSnapshotStore();
    store.remember('/tmp/recover-conflict-trap.txt', { ...readSnapshotOf(read), recordedAt: 'read' });
    const { tool, writeText } = toolWithStore(changed, store);

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/recover-conflict-trap.txt',
        new_string: 'DELTA-NEW',
        start_line: 5,
        end_line: 5,
        anchor: readSnapshotOf(read).anchor,
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('fall inside unresolved merge conflict markers');
    expect(result.output).toContain('lines 2-2 of /tmp/recover-conflict-trap.txt');
    expect(result.output).toContain('after the remap of your lines 5-5');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('refuses when the external change deletes part of the targeted window', async () => {
    const read = 'a\nb\nc\nd\ne\n';
    const changed = 'a\nb\nd\ne\n';
    const store = new EditSnapshotStore();
    store.remember('/tmp/recover-overlap.txt', { ...readSnapshotOf(read), recordedAt: 'read' });
    const { tool, writeText } = toolWithStore(changed, store);

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/recover-overlap.txt',
        new_string: 'X',
        start_line: 3,
        end_line: 5,
        anchor: readSnapshotOf(read).anchor,
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('The file changed externally in the region you are targeting');
    expect(result.output).toContain('Re-read the file and re-anchor before retrying.');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('hard-rejects when the store is wired but holds no snapshot', async () => {
    const store = new EditSnapshotStore();
    const { tool, writeText } = toolWithStore('alpha beta', store);

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/recover-empty-store.txt',
        new_string: 'X',
        start_line: 1,
        end_line: 1,
        anchor: 'deadbeef',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toBe(
      `File has changed since last read. The anchor no longer matches (expected deadbeef, got ${computeAnchor('alpha beta')}). Please re-read the file and retry.`,
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it('hard-rejects replace_range when no store is wired (unchanged legacy behaviour)', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue('one\ntwo\n'),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/recover-no-store.txt',
        new_string: 'X',
        start_line: 1,
        end_line: 1,
        anchor: 'deadbeef',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toBe(
      `File has changed since last read. The anchor no longer matches (expected deadbeef, got ${computeAnchor('one\ntwo\n')}). Please re-read the file and retry.`,
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it('hard-rejects str_replace mode even with a usable snapshot', async () => {
    const read = 'alpha beta';
    const changed = 'alpha beta!';
    const store = new EditSnapshotStore();
    store.remember('/tmp/recover-str.txt', { ...readSnapshotOf(read), recordedAt: 'read' });
    const { tool, writeText } = toolWithStore(changed, store);

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/recover-str.txt',
        old_string: 'alpha',
        new_string: 'X',
        anchor: 'deadbeef',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toBe(
      `File has changed since last read. The anchor no longer matches (expected deadbeef, got ${computeAnchor(changed)}). Please re-read the file and retry.`,
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it('hard-rejects when the snapshot anchor differs from the supplied anchor', async () => {
    const store = new EditSnapshotStore();
    // Post-edit snapshots carry the anchor of what WE wrote, which can never
    // be the anchor the model holds (it comes from a Read) — remapping the
    // model's numbers against a foreign view would be wrong.
    store.remember('/tmp/recover-anchor.txt', {
      content: 'snapshot text\n',
      anchor: 'otheranchor',
      recordedAt: 'edit',
    });
    const { tool, writeText } = toolWithStore('current text\n', store);

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/recover-anchor.txt',
        new_string: 'X',
        start_line: 1,
        end_line: 1,
        anchor: 'deadbeef',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toBe(
      `File has changed since last read. The anchor no longer matches (expected deadbeef, got ${computeAnchor('current text\n')}). Please re-read the file and retry.`,
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rolls back when the recovery apply introduces new LSP errors', async () => {
    const read = 'one\ntwo\nthree\n';
    const changed = 'one\ntwo\nthree\nAPPEND\n';
    const store = new EditSnapshotStore();
    store.remember('/tmp/recover-rollback.ts', { ...readSnapshotOf(read), recordedAt: 'read' });
    const writeText = vi.fn().mockResolvedValue(0);
    const { tool } = toolWithStore(changed, store, writeText, recoveryRegistry([
      errorDiagnostics(1),
      errorDiagnostics(2),
    ]));

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/recover-rollback.ts',
        new_string: 'TWO',
        start_line: 2,
        end_line: 2,
        anchor: readSnapshotOf(read).anchor,
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain(
      'Recovery applied but introduced 1 new error(s) reported by the language server; the edit was rolled back. Re-read the file and re-anchor.',
    );
    // First write applies the remapped edit, second write restores the
    // pre-apply (externally changed) file.
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText.mock.calls[0]).toEqual(['/tmp/recover-rollback.ts', 'one\nTWO\nthree\nAPPEND\n']);
    expect(writeText.mock.calls[1]).toEqual(['/tmp/recover-rollback.ts', changed]);
    // The rolled-back apply must not be recorded as a post-edit snapshot.
    expect(store.recall('/tmp/recover-rollback.ts')?.recordedAt).toBe('read');
  });

  it('does not roll back when pre-existing errors keep the same count', async () => {
    const read = 'one\ntwo\nthree\n';
    const changed = 'one\ntwo\nthree\nAPPEND\n';
    const store = new EditSnapshotStore();
    store.remember('/tmp/recover-stable.ts', { ...readSnapshotOf(read), recordedAt: 'read' });
    const writeText = vi.fn().mockResolvedValue(0);
    const { tool } = toolWithStore(changed, store, writeText, recoveryRegistry([
      errorDiagnostics(1),
      errorDiagnostics(1),
    ]));

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/recover-stable.ts',
        new_string: 'TWO',
        start_line: 2,
        end_line: 2,
        anchor: readSnapshotOf(read).anchor,
      }),
    );

    // The apply went through once (no restore write) and the remap note
    // stands; the pre-existing error keeps the fix-then-re-verify gate on.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(result.output).not.toContain('rolled back');
    expect(result.output).toContain(
      'your line range was remapped (snapshot lines 2-2 → current lines 2-2)',
    );
    expect(store.recall('/tmp/recover-stable.ts')?.recordedAt).toBe('edit');
  });

  it('skips the diagnostics gate when no active client exists', async () => {
    const read = 'one\ntwo\nthree\n';
    const changed = 'one\ntwo\nthree\nAPPEND\n';
    const store = new EditSnapshotStore();
    store.remember('/tmp/recover-no-client.ts', { ...readSnapshotOf(read), recordedAt: 'read' });
    const writeText = vi.fn().mockResolvedValue(0);
    // getClient would report errors, but activeClientFor finds no running
    // client — the gate is skipped and the apply is never rolled back.
    let call = 0;
    const fakeClient = {
      didOpen: vi.fn(),
      didChange: vi.fn(),
      diagnosticsReport: vi.fn().mockImplementation(async () => {
        call += 1;
        return { diagnostics: errorDiagnostics(call), observed: true };
      }),
    };
    const registry = {
      activeClientFor: vi.fn().mockResolvedValue(undefined),
      getClient: vi.fn().mockResolvedValue(fakeClient),
      languageIdForPath: vi.fn().mockReturnValue('typescript'),
      commandForPath: vi.fn().mockReturnValue(['fake-lsp', '--stdio']),
      stopAll: vi.fn(),
    } as unknown as LspRegistry;
    const { tool } = toolWithStore(changed, store, writeText, registry);

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/recover-no-client.ts',
        new_string: 'TWO',
        start_line: 2,
        end_line: 2,
        anchor: readSnapshotOf(read).anchor,
      }),
    );

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(result.output).not.toContain('rolled back');
    expect(result.output).toContain(
      'your line range was remapped (snapshot lines 2-2 → current lines 2-2)',
    );
  });

  it('records a post-edit snapshot after a successful str_replace edit', async () => {
    const content = 'alpha beta';
    const store = new EditSnapshotStore();
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new EditTool(
      createFakeJian({
        readText: vi.fn().mockResolvedValue(content),
        writeText,
      }),
      PERMISSIVE_WORKSPACE,
      undefined,
      undefined,
      store,
    );

    const result = await executeTool(
      tool,
      context({
        path: '/tmp/recover-edit-snap.txt',
        old_string: 'alpha',
        new_string: 'X',
        anchor: computeAnchor(toModelTextView(content).text),
      }),
    );

    expect(result.isError).toBeFalsy();
    const after = store.recall('/tmp/recover-edit-snap.txt');
    expect(after?.recordedAt).toBe('edit');
    expect(after?.content).toBe('X beta');
    expect(after?.anchor).toBe(computeAnchor('X beta'));
  });
});
