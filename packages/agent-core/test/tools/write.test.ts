import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LspDiagnostic } from '../../src/lsp/client';
import type { LspRegistry } from '../../src/lsp/registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type WriteInput, WriteInputSchema, WriteTool } from '../../src/tools/builtin/file/write';
import { fileDiffSummary } from '../../src/tools/support/file-diff';
import { testJian } from '../fixtures/test-jian';
import { createFakeJian, PERMISSIVE_WORKSPACE, toolContentString } from './fixtures/fake-jian';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function context(args: WriteInput) {
  return { turnId: '0', toolCallId: 'call_write', args, signal };
}

/** stat() result for an existing directory (S_IFDIR mode bits). */
const DIR_STAT = vi.fn().mockResolvedValue({ stMode: 0o040755 });

describe('WriteTool', () => {
  it('exposes current metadata and schema', () => {
    const tool = new WriteTool(createFakeJian(), PERMISSIVE_WORKSPACE);

    expect(tool.name).toBe('Write');
    // "exactly as provided" and mode defaults are in the field-level schema
    // describe, not the tool-level description.
    expect(tool.description).toContain('does not preserve or infer the previous line-ending style');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: expect.stringContaining('Raw full file content'),
        },
        mode: {
          enum: ['overwrite', 'append'],
          description: expect.stringContaining('Defaults to overwrite'),
        },
      },
    });
    expect(WriteInputSchema.safeParse({ path: '/tmp/out.txt', content: 'hello' }).success).toBe(
      true,
    );
    expect(
      WriteInputSchema.safeParse({ path: '/tmp/out.txt', content: 'hello', mode: 'append' })
        .success,
    ).toBe(true);
    expect(
      WriteInputSchema.safeParse({ path: '/tmp/out.txt', content: 'hello', mode: 'bad' }).success,
    ).toBe(false);
    expect(WriteInputSchema.safeParse({ path: '/tmp/out.txt' }).success).toBe(false);
  });

  it('describes the working-directory rule for the path parameter', () => {
    const tool = new WriteTool(createFakeJian(), PERMISSIVE_WORKSPACE);
    const params = tool.parameters as {
      properties: { path: { description: string } };
    };

    expect(params.properties.path.description).toContain('working directory');
    expect(params.properties.path.description).toMatch(/relative/i);
    expect(params.properties.path.description).toMatch(/absolute/i);
  });

  it('exposes the content on the file_io display so the approval panel can preview it', async () => {
    const tool = new WriteTool(createFakeJian(), PERMISSIVE_WORKSPACE);
    const execution = await tool.resolveExecution({
      path: '/tmp/new.txt',
      content: 'hello\nworld',
    });
    if (execution.isError === true) {
      throw new TypeError('expected runnable execution');
    }
    expect(execution.display).toEqual({
      kind: 'file_io',
      operation: 'write',
      path: '/tmp/new.txt',
      content: 'hello\nworld',
    });
  });

  it('matches permission args with negated glob path semantics', async () => {
    const tool = new WriteTool(createFakeJian(), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });
    const insideSrc = await tool.resolveExecution({ path: './src/a.ts', content: 'x' });
    const outsideSrc = await tool.resolveExecution({ path: './README.md', content: 'x' });
    if (insideSrc.isError === true || outsideSrc.isError === true) {
      throw new TypeError('expected runnable execution');
    }

    expect(insideSrc.matchesRule?.('!./src/**')).toBe(false);
    expect(outsideSrc.matchesRule?.('!./src/**')).toBe(true);
  });

  it('guides batching large content across multiple write calls', () => {
    const tool = new WriteTool(createFakeJian(), PERMISSIVE_WORKSPACE);

    // The guidance must mention splitting large content across multiple calls,
    // and spell out the first-overwrite-then-append ordering.
    expect(tool.description).toMatch(/large/i);
    expect(tool.description).toMatch(/split[^.]*multiple calls/i);
    expect(tool.description).toMatch(/first[^.]*overwrite[^.]*then[^.]*append/i);
  });

  it('writes content through jian and reports bytes written', async () => {
    const writeText = vi.fn().mockResolvedValue(5);
    const tool = new WriteTool(createFakeJian({ writeText, stat: DIR_STAT }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool, context({ path: '/tmp/new.txt', content: 'hello' }));

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', 'hello');
    expect(result.output).toContain('Wrote 5 bytes');
  });

  it('expands leading tilde paths using the jian home directory', async () => {
    const writeText = vi.fn().mockResolvedValue(5);
    const tool = new WriteTool(createFakeJian({ writeText, stat: DIR_STAT }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool, context({ path: '~/notes/today.txt', content: 'hello' }));

    expect(writeText).toHaveBeenCalledWith('/home/test/notes/today.txt', 'hello');
    expect(result.output).toContain('Wrote 5 bytes');
  });

  it('appends content through jian and reports appended bytes', async () => {
    const writeText = vi.fn().mockResolvedValue(6);
    const tool = new WriteTool(createFakeJian({ writeText, stat: DIR_STAT }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,
      context({ path: '/tmp/existing.txt', content: '\nhello', mode: 'append' }),
    );

    expect(writeText).toHaveBeenCalledWith('/tmp/existing.txt', '\nhello', { mode: 'a' });
    expect(result.output).toContain('Appended 6 bytes');
  });

  it('reports the real UTF-8 byte count for non-ASCII content', async () => {
    // Six Japanese characters: each encodes to 3 UTF-8 bytes → 18 bytes total,
    // even though the JS string length is 6. The reported count must reflect
    // the bytes that land on disk, not the code-unit count.
    const content = 'こんにちは。';
    const expectedBytes = Buffer.byteLength(content, 'utf8');
    expect(expectedBytes).toBe(18);

    // writeText's contract returns a character count; the tool must not rely
    // on it for the byte figure.
    const writeText = vi.fn().mockResolvedValue(content.length);
    const tool = new WriteTool(createFakeJian({ writeText, stat: DIR_STAT }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool, context({ path: '/tmp/jp.txt', content }));

    expect(result.output).toContain('Wrote 18 bytes');
    expect(result.output).not.toContain('Wrote 6 bytes');
  });

  it('reports the real UTF-8 byte count for content with surrogate-pair emoji', async () => {
    // 'hi😀': the emoji is a single code point encoded as a UTF-16 surrogate
    // pair, so JS string length is 4 (2 for 'hi' + 2 code units), but the
    // UTF-8 encoding is 6 bytes (2 for 'hi' + 4 for the emoji). The reported
    // count must reflect the bytes on disk, not the code-unit count — this
    // is the sharpest edge of the byte-counting bug.
    const content = 'hi😀';
    expect(content.length).toBe(4);
    const expectedBytes = Buffer.byteLength(content, 'utf8');
    expect(expectedBytes).toBe(6);

    // writeText's contract returns a character count; the tool must not rely
    // on it for the byte figure.
    const writeText = vi.fn().mockResolvedValue(content.length);
    const tool = new WriteTool(createFakeJian({ writeText, stat: DIR_STAT }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool, context({ path: '/tmp/emoji.txt', content }));

    expect(result.output).toContain('Wrote 6 bytes');
    expect(result.output).not.toContain('Wrote 4 bytes');
  });

  it('reports the real UTF-8 byte count for non-ASCII append content', async () => {
    const content = 'café';
    const expectedBytes = Buffer.byteLength(content, 'utf8');
    expect(expectedBytes).toBe(5);

    const writeText = vi.fn().mockResolvedValue(content.length);
    const tool = new WriteTool(createFakeJian({ writeText, stat: DIR_STAT }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,
      context({ path: '/tmp/menu.txt', content, mode: 'append' }),
    );

    expect(result.output).toContain('Appended 5 bytes');
  });

  it('reports a friendly error when the parent directory does not exist', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
    });
    const stat = vi.fn().mockRejectedValue(enoent);
    const writeText = vi.fn().mockResolvedValue(4);
    const tool = new WriteTool(createFakeJian({ stat, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,
      context({ path: '/tmp/missing-dir/file.txt', content: 'data' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('/tmp/missing-dir');
    expect(result.output).toMatch(/parent directory/i);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects writing when the parent path is not a directory', async () => {
    // A regular file (S_IFREG) standing where a directory is expected.
    const stat = vi.fn().mockResolvedValue({ stMode: 0o100644 });
    const writeText = vi.fn().mockResolvedValue(4);
    const tool = new WriteTool(createFakeJian({ stat, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,
      context({ path: '/tmp/a-file/child.txt', content: 'data' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toMatch(/not a directory/i);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('writes when the parent directory exists', async () => {
    const stat = vi.fn().mockResolvedValue({ stMode: 0o040755 });
    const writeText = vi.fn().mockResolvedValue(4);
    const tool = new WriteTool(createFakeJian({ stat, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool, context({ path: '/tmp/exists/file.txt', content: 'data' }));

    expect(result.isError).toBeUndefined();
    expect(writeText).toHaveBeenCalledWith('/tmp/exists/file.txt', 'data');
  });

  it('surfaces jian write failures as tool errors', async () => {
    const tool = new WriteTool(
      createFakeJian({
        stat: DIR_STAT,
        writeText: vi.fn().mockRejectedValue(new Error('disk full')),
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/some/file.txt', content: 'data' }));

    expect(result).toMatchObject({ isError: true, output: 'disk full' });
  });

  it('allows explicit absolute writes outside the workspace', async () => {
    const writeText = vi.fn().mockResolvedValue(1);
    const tool = new WriteTool(createFakeJian({ writeText, stat: DIR_STAT }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ path: '/tmp/pwned.txt', content: 'x' }));

    expect(result.isError).toBeUndefined();
    expect(writeText).toHaveBeenCalledWith('/tmp/pwned.txt', 'x');
  });

  it('rejects relative traversal writes before jian I/O', async () => {
    const writeText = vi.fn().mockResolvedValue(1);
    const tool = new WriteTool(createFakeJian({ writeText }), {
      workspaceDir: '/workspace/project',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ path: '../outside.txt', content: 'x' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('absolute path');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('blocks sensitive file writes', async () => {
    const writeText = vi.fn().mockResolvedValue(1);
    const tool = new WriteTool(createFakeJian({ writeText }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ path: '/workspace/id_rsa', content: 'key' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('sensitive-file pattern');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('round-trips unicode content (CJK + emoji + accented Latin) through jian.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new WriteTool(createFakeJian({ writeText }), PERMISSIVE_WORKSPACE);
    const content = 'Hello 世界 🌍\nUnicode: café, naïve, résumé';

    const result = await executeTool(tool,context({ path: '/tmp/unicode.txt', content }));

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/unicode.txt', content);
  });

  it('writes empty content as a zero-byte file via jian.writeText("")', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new WriteTool(createFakeJian({ writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,context({ path: '/tmp/empty.txt', content: '' }));

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/empty.txt', '');
  });

  it('reports a parent-directory-does-not-exist message when the directory is missing', async () => {
    // py surfaces `parent directory does not exist` so the model can `mkdir`
    // before retrying. TS currently forwards whatever the host throws.
    const writeText = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
      );
    const tool = new WriteTool(createFakeJian({ writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,
      context({ path: '/tmp/missing-dir/file.txt', content: 'data' }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('parent directory does not exist');
  });

  it('appending to a nonexistent file creates it with just the appended bytes', async () => {
    // py spec: append mode on a missing path returns success and creates
    // the file. Lock down the create-on-append contract.
    const writeText = vi.fn().mockResolvedValue(11);
    const tool = new WriteTool(createFakeJian({ writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,
      context({ path: '/tmp/new-append.txt', content: 'New content', mode: 'append' }),
    );

    expect(result.isError).toBeFalsy();
    expect(toolContentString(result).toLowerCase()).toContain('appended');
    expect(writeText).toHaveBeenCalledWith('/tmp/new-append.txt', 'New content', { mode: 'a' });
  });

  it('allows absolute writes to a sibling dir that merely shares the work-dir prefix', async () => {
    // Path policy must distinguish "shares a prefix with workspaceDir" from
    // "is inside workspaceDir". /workspace-sneaky/* is outside /workspace.
    const writeText = vi.fn().mockResolvedValue(1);
    const tool = new WriteTool(createFakeJian({ writeText }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool,
      context({ path: '/workspace-sneaky/file.txt', content: 'content' }),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/workspace-sneaky/file.txt', 'content');
  });

  it('refuses to overwrite with content containing merge conflict markers', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new WriteTool(createFakeJian({ writeText }), PERMISSIVE_WORKSPACE);

    const content = [
      'function foo() {',
      '<<<<<<< HEAD',
      '  return 1;',
      '=======',
      '  return 2;',
      '>>>>>>> branch',
      '}',
    ].join('\n');

    const result = await executeTool(tool, context({ path: '/tmp/conflict.ts', content }));

    expect(result.isError).toBe(true);
    expect(result.output).toContain('merge conflict markers');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('refuses to append content containing merge conflict markers', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new WriteTool(createFakeJian({ writeText }), PERMISSIVE_WORKSPACE);

    const content = [
      '// old content',
      '<<<<<<< HEAD',
      '  old code',
      '=======',
      '  new code',
      '>>>>>>> branch',
    ].join('\n');

    const result = await executeTool(
      tool,
      context({ path: '/tmp/conflict.ts', content, mode: 'append' }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('merge conflict markers');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('allows writing content without conflict markers', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new WriteTool(createFakeJian({ writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({ path: '/tmp/clean.ts', content: 'function foo() { return 1; }\n' }),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalled();
  });

  it('marks isError when LSP reports error-severity diagnostics after write', async () => {
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

    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new WriteTool(
      createFakeJian({ writeText, readText: vi.fn().mockResolvedValue('content') }),
      PERMISSIVE_WORKSPACE,
      registry,
    );

    const result = await executeTool(
      tool,
      context({ path: '/tmp/bad.ts', content: 'const x: number = "bad";\n' }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Wrote');
    expect(result.output).not.toContain('[LSP]');
    expect(result.message).toContain('[LSP]');
    expect(result.message).toContain('Type error');
  });

  it('does not mark isError when LSP reports only warnings after write', async () => {
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

    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new WriteTool(
      createFakeJian({ writeText, readText: vi.fn().mockResolvedValue('content') }),
      PERMISSIVE_WORKSPACE,
      registry,
    );

    const result = await executeTool(
      tool,
      context({ path: '/tmp/a.ts', content: 'const x = 1;\n' }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain('[LSP]');
    expect(result.message).toContain('[LSP]');
    expect(result.message).toContain('Unused variable');
  });
});

describe('WriteTool file_diff display', () => {
  // The overwrite cases run against real files on disk (LocalJian) so the
  // removed-line count is checked against the file's true previous contents —
  // the number the argument-derived UI heuristic cannot see.
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scream-write-diff-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a created file as pure additions', async () => {
    const path = join(dir, 'created.txt');
    const content = 'one\ntwo\nthree\n';
    const tool = new WriteTool(testJian, PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool, context({ path, content }));

    expect(result.isError).toBeFalsy();
    if (result.isError === true) throw new Error('expected success result');
    expect(await readFile(path, 'utf8')).toBe(content);
    expect(result.display).toEqual({ kind: 'file_diff', added: 3, removed: 0 });
  });

  it('reports an append as pure additions of the appended text', async () => {
    const path = join(dir, 'appended.txt');
    await writeFile(path, 'first\n', 'utf8');
    const tool = new WriteTool(testJian, PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({ path, content: 'second\nthird\n', mode: 'append' }),
    );

    expect(result.isError).toBeFalsy();
    if (result.isError === true) throw new Error('expected success result');
    expect(await readFile(path, 'utf8')).toBe('first\nsecond\nthird\n');
    expect(result.display).toEqual({ kind: 'file_diff', added: 2, removed: 0 });
  });

  it('reports an append that rewrites an unterminated last line', async () => {
    // Appending concatenates bytes: the old last line is rewritten by the first
    // appended line, so the honest counts are "+2 -1" — reporting "+2 -0" would
    // hide a line the append actually changed.
    const path = join(dir, 'unterminated.txt');
    await writeFile(path, 'first', 'utf8');
    const tool = new WriteTool(testJian, PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({ path, content: 'second\nthird\n', mode: 'append' }),
    );

    expect(result.isError).toBeFalsy();
    if (result.isError === true) throw new Error('expected success result');
    expect(await readFile(path, 'utf8')).toBe('firstsecond\nthird\n');
    expect(result.display).toEqual({ kind: 'file_diff', added: 2, removed: 1 });
  });

  it('reports an append to a nonexistent file as pure additions', async () => {
    const path = join(dir, 'appended-new.txt');
    const tool = new WriteTool(testJian, PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({ path, content: 'only line\n', mode: 'append' }),
    );

    expect(result.isError).toBeFalsy();
    if (result.isError === true) throw new Error('expected success result');
    expect(await readFile(path, 'utf8')).toBe('only line\n');
    expect(result.display).toEqual({ kind: 'file_diff', added: 1, removed: 0 });
  });

  it('diffs an overwrite against the real previous contents', async () => {
    const path = join(dir, 'rewritten.txt');
    const before = 'one\ntwo\nthree\nfour\n';
    const content = 'one\nTWO\nthree\n';
    await writeFile(path, before, 'utf8');
    const tool = new WriteTool(testJian, PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool, context({ path, content }));

    expect(result.isError).toBeFalsy();
    if (result.isError === true) throw new Error('expected success result');
    const after = await readFile(path, 'utf8');
    expect(after).toBe(content);
    expect(fileDiffSummary(before, after)).toEqual({ added: 1, removed: 2 });
    expect(result.display).toEqual({ kind: 'file_diff', added: 1, removed: 2 });
  });

  it('reports an empty overwrite of a non-empty file as pure removals', async () => {
    const path = join(dir, 'emptied.txt');
    const before = 'one\ntwo\n';
    await writeFile(path, before, 'utf8');
    const tool = new WriteTool(testJian, PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool, context({ path, content: '' }));

    expect(result.isError).toBeFalsy();
    if (result.isError === true) throw new Error('expected success result');
    const after = await readFile(path, 'utf8');
    expect(after).toBe('');
    expect(fileDiffSummary(before, after)).toEqual({ added: 0, removed: 2 });
    expect(result.display).toEqual({ kind: 'file_diff', added: 0, removed: 2 });
  });

  it('omits the display when the line diff exceeds its budget', async () => {
    // Rewriting a file with content that shares no lines with the old one is
    // jsdiff's worst case (minutes without a budget). The tool must give up and
    // report no counts at all instead of blocking, leaving the UI on its
    // argument-derived fallback; the write itself is unaffected.
    const before = Array.from({ length: 24_000 }, (_, i) => `{"k${String(i)}":${String(i)}}`).join('\n');
    const after = Array.from({ length: 24_000 }, (_, i) => `{"x${String(i)}":${String(i * 7)}}`).join('\n');
    const path = join(dir, 'adversarial.json');
    await writeFile(path, before, 'utf8');
    const tool = new WriteTool(testJian, PERMISSIVE_WORKSPACE);

    const started = Date.now();
    const result = await executeTool(tool, context({ path, content: after }));
    const elapsed = Date.now() - started;

    expect(result.isError).toBeFalsy();
    expect(Object.keys(result)).not.toContain('display');
    expect(elapsed).toBeLessThan(5_000);
    expect(await readFile(path, 'utf8')).toBe(after);
  }, 30_000);

  it('omits the display when the previous contents cannot be read', async () => {
    // FakeJian without readText: the pre-write state is unknown, so the tool
    // must not guess. The write itself still happens.
    const writeText = vi.fn().mockResolvedValue(4);
    const tool = new WriteTool(
      createFakeJian({ writeText, stat: DIR_STAT }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/tmp/unknown.txt', content: 'data' }));

    expect(result.isError).toBeFalsy();
    expect(Object.keys(result)).not.toContain('display');
    expect(writeText).toHaveBeenCalledWith('/tmp/unknown.txt', 'data');
  });

  it('skips the diff without reading when the target is oversized', async () => {
    // The target is a 1 MB+ regular file; its parent is a directory.
    const stat = vi.fn().mockImplementation((path: string) =>
      Promise.resolve(
        path === '/tmp/huge.txt'
          ? { stMode: 0o100644, stSize: 1_000_001 }
          : { stMode: 0o040755 },
      ),
    );
    const readText = vi.fn().mockResolvedValue('never used');
    const writeText = vi.fn().mockResolvedValue(4);
    const tool = new WriteTool(createFakeJian({ stat, readText, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool, context({ path: '/tmp/huge.txt', content: 'data' }));

    expect(result.isError).toBeFalsy();
    expect(readText).not.toHaveBeenCalled();
    expect(Object.keys(result)).not.toContain('display');
    expect(writeText).toHaveBeenCalledWith('/tmp/huge.txt', 'data');
  });

  it('omits the display when the write fails', async () => {
    const tool = new WriteTool(
      createFakeJian({
        stat: DIR_STAT,
        readText: vi.fn().mockResolvedValue('previous contents'),
        writeText: vi.fn().mockRejectedValue(new Error('disk full')),
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/some/file.txt', content: 'data' }));

    expect(result).toMatchObject({ isError: true });
    expect(Object.keys(result)).not.toContain('display');
  });

  it('omits the display when the content is rejected before any write', async () => {
    const readText = vi.fn().mockResolvedValue('previous contents');
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new WriteTool(createFakeJian({ stat: DIR_STAT, readText, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(
      tool,
      context({ path: '/tmp/conflict.ts', content: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch' }),
    );

    expect(result.isError).toBe(true);
    expect(Object.keys(result)).not.toContain('display');
    expect(readText).not.toHaveBeenCalled();
  });
});
