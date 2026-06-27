import type { LspDiagnostic } from '../../src/lsp/client';
import type { LspRegistry } from '../../src/lsp/registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type EditInput, EditInputSchema, EditTool } from '../../src/tools/builtin/file/edit';
import { computeAnchor, toModelTextView } from '../../src/tools/builtin/file/line-endings';
import { resetNoopLoop } from '../../src/tools/builtin/file/noop-loop-guard';
import { createFakeJian, PERMISSIVE_WORKSPACE } from './fixtures/fake-jian';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function context(args: EditInput) {
  return { turnId: '0', toolCallId: 'call_edit', args, signal };
}

describe('EditTool', () => {
  it('exposes before/after on the file_io display so the approval panel can render a diff', () => {
    const tool = new EditTool(createFakeJian(), PERMISSIVE_WORKSPACE);
    const execution = tool.resolveExecution({
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
    expect(tool.description).toContain('omit the line-number prefix');
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
        diagnostics: vi.fn().mockResolvedValue([errorDiag]),
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
        diagnostics: vi.fn().mockResolvedValue([warningDiag]),
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
  });
});

describe('EditTool noop-loop-guard', () => {
  const NOOP_PATHS = ['/tmp/noop-a.txt', '/tmp/noop-b.txt', '/tmp/noop-c.txt'];

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
});
