import type { Jian } from '@scream-code/jian';
import { describe, expect, it, vi } from 'vitest';

import type { LspRegistry } from '../../src/lsp/registry';
import { ReadGroupTool, ReadGroupInputSchema } from '../../src/tools/builtin/file/read-group';
import type { ReadGroupInput } from '../../src/tools/builtin/file/read-group';
import { createFakeJian } from './fixtures/fake-jian';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

const REGULAR_FILE_STAT = {
  stMode: 0o100_644,
  stIno: 1,
  stDev: 1,
  stNlink: 1,
  stUid: 1000,
  stGid: 1000,
  stSize: 0,
  stAtime: 0,
  stMtime: 0,
  stCtime: 0,
} satisfies Awaited<ReturnType<Jian['stat']>>;

const ENOENT_ERROR = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

function context(args: ReadGroupInput) {
  return {
    turnId: '0',
    toolCallId: 'call_readgroup',
    args,
    signal,
  };
}

function jianWithFiles(fileContents: Record<string, string>): Jian {
  return createFakeJian({
    stat: vi.fn<Jian['stat']>().mockImplementation(async (p) => {
      if (fileContents[p] === undefined) throw ENOENT_ERROR;
      return REGULAR_FILE_STAT;
    }),
    readBytes: vi.fn<Jian['readBytes']>().mockImplementation(async (p, n) => {
      const content = fileContents[p] ?? '';
      const bytes = Buffer.from(content, 'utf8');
      return n === undefined ? bytes : bytes.subarray(0, n);
    }),
    readLines: vi.fn<Jian['readLines']>().mockImplementation(async function* (p: string) {
      const content = fileContents[p] ?? '';
      if (content === '') return;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        yield i < lines.length - 1 ? `${line}\n` : line;
      }
    }),
    glob: async function* (): AsyncGenerator<string> {},
    iterdir: async function* (): AsyncGenerator<string> {},
  });
}

describe('ReadGroupTool', () => {
  it('reads multiple existing files', async () => {
    const tool = new ReadGroupTool(
      jianWithFiles({
        '/workspace/a.ts': 'content A',
        '/workspace/b.ts': 'content B',
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(
      tool,
      context({ paths: ['/workspace/a.ts', '/workspace/b.ts'] }),
    );

    expect(result.isError).toBeFalsy();
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('--- /workspace/a.ts ---');
    expect(output).toContain('content A');
    expect(output).toContain('--- /workspace/b.ts ---');
    expect(output).toContain('content B');
  });

  it('skips missing paths and continues with existing ones', async () => {
    const tool = new ReadGroupTool(
      jianWithFiles({ '/workspace/existing.ts': 'present' }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(
      tool,
      context({ paths: ['/workspace/existing.ts', '/workspace/missing.ts'] }),
    );

    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('present');
    expect(output).toContain('--- /workspace/missing.ts ---');
    expect(output).toContain('[ERROR]');
    expect(output).toContain('Skipped missing paths: /workspace/missing.ts');
  });

  it('fails when all paths are missing', async () => {
    const tool = new ReadGroupTool(jianWithFiles({}), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(
      tool,
      context({ paths: ['/workspace/a.ts', '/workspace/b.ts'] }),
    );

    expect(result).toMatchObject({ isError: true });
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('Paths not found: /workspace/a.ts, /workspace/b.ts');
  });

  it('single path keeps strict ENOENT semantics (no partition)', async () => {
    const tool = new ReadGroupTool(jianWithFiles({}), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(
      tool,
      context({ paths: ['/workspace/only.ts'] }),
    );

    expect(result).toMatchObject({ isError: true });
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('--- /workspace/only.ts ---');
    expect(output).toContain('[ERROR]');
    expect(output).not.toContain('Paths not found');
  });

  it('preserves input order in output', async () => {
    const tool = new ReadGroupTool(
      jianWithFiles({
        '/workspace/zebra.ts': 'Z',
        '/workspace/apple.ts': 'A',
        '/workspace/mango.ts': 'M',
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(
      tool,
      context({ paths: ['/workspace/zebra.ts', '/workspace/apple.ts', '/workspace/mango.ts'] }),
    );

    const output = typeof result.output === 'string' ? result.output : '';
    const zebraIdx = output.indexOf('--- /workspace/zebra.ts ---');
    const appleIdx = output.indexOf('--- /workspace/apple.ts ---');
    const mangoIdx = output.indexOf('--- /workspace/mango.ts ---');
    expect(zebraIdx).toBeLessThan(appleIdx);
    expect(appleIdx).toBeLessThan(mangoIdx);
  });

  it('continues reading valid files when one path hits a non-ENOENT stat error', async () => {
    const eaccesError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const tool = new ReadGroupTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockImplementation(async (p) => {
          if (p === '/workspace/locked.ts') throw eaccesError;
          return REGULAR_FILE_STAT;
        }),
        readBytes: vi.fn<Jian['readBytes']>().mockImplementation(async (_p, n) => {
          const bytes = Buffer.from('ok\n', 'utf8');
          return n === undefined ? bytes : bytes.subarray(0, n);
        }),
        readLines: vi.fn<Jian['readLines']>().mockImplementation(async function* () {
          yield 'ok\n';
        }),
        glob: async function* (): AsyncGenerator<string> {},
        iterdir: async function* (): AsyncGenerator<string> {},
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(
      tool,
      context({ paths: ['/workspace/ok.ts', '/workspace/locked.ts'] }),
    );

    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('--- /workspace/ok.ts ---');
    expect(output).toContain('ok');
    expect(output).toContain('--- /workspace/locked.ts ---');
    expect(output).toContain('[ERROR]');
    expect(result.isError).toBe(true);
  });

  it('appends conflict-marker footer when a file has merge conflicts', async () => {
    const conflictContent = [
      'function foo() {',
      '<<<<<<< HEAD',
      '  return 1;',
      '=======',
      '  return 2;',
      '>>>>>>> branch',
      '}',
    ].join('\n');
    const cleanContent = 'function bar() {\n  return 3;\n}\n';

    const tool = new ReadGroupTool(
      jianWithFiles({
        '/workspace/conflict.ts': conflictContent,
        '/workspace/clean.ts': cleanContent,
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(
      tool,
      context({ paths: ['/workspace/conflict.ts', '/workspace/clean.ts'] }),
    );

    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('Conflict markers detected');
    expect(output).toContain('/workspace/conflict.ts');
    expect(output).toContain('lines 2-6');
  });

  it('omits conflict footer when no file has conflicts', async () => {
    const tool = new ReadGroupTool(
      jianWithFiles({
        '/workspace/a.ts': 'function foo() { return 1; }\n',
        '/workspace/b.ts': 'function bar() { return 2; }\n',
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(
      tool,
      context({ paths: ['/workspace/a.ts', '/workspace/b.ts'] }),
    );

    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).not.toContain('Conflict markers detected');
  });

  it('groups output by file extension', async () => {
    const tool = new ReadGroupTool(
      jianWithFiles({
        '/workspace/a.ts': 'const x = 1;\n',
        '/workspace/b.md': '# Title\n',
        '/workspace/c.ts': 'const y = 2;\n',
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(
      tool,
      context({ paths: ['/workspace/a.ts', '/workspace/b.md', '/workspace/c.ts'] }),
    );

    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('── .md (1) ──');
    expect(output).toContain('── .ts (2) ──');
    const mdIdx = output.indexOf('── .md (1) ──');
    const tsIdx = output.indexOf('── .ts (2) ──');
    expect(mdIdx).toBeLessThan(tsIdx);
    expect(tsIdx).toBeLessThan(output.indexOf('--- /workspace/a.ts ---'));
  });

  it('appends import summary footer for TypeScript files', async () => {
    const tool = new ReadGroupTool(
      jianWithFiles({
        '/workspace/a.ts': "import { foo } from './b';\nimport { bar } from './c';\n",
        '/workspace/b.ts': 'export const foo = 1;\n',
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(
      tool,
      context({ paths: ['/workspace/a.ts', '/workspace/b.ts'] }),
    );

    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('Imports:');
    expect(output).toContain('a.ts → ./b, ./c');
  });

  it('accepts up to 20 paths', async () => {
    const files: Record<string, string> = {};
    const paths: string[] = [];
    for (let i = 0; i < 20; i++) {
      files[`/workspace/f${i}.ts`] = `content ${i}\n`;
      paths.push(`/workspace/f${i}.ts`);
    }

    const tool = new ReadGroupTool(
      jianWithFiles(files),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ paths }));

    expect(result.isError).toBeFalsy();
  });

  it('rejects more than 20 paths at schema level', () => {
    const paths: string[] = [];
    for (let i = 0; i < 21; i++) {
      paths.push(`/workspace/f${i}.ts`);
    }
    const result = ReadGroupInputSchema.safeParse({ paths });
    expect(result.success).toBe(false);
  });
});

describe('ReadGroupTool — LSP registry threading', () => {
  it('threads the lsp registry through so grouped reads carry the outline footer', async () => {
    // The footer only applies to files of at least 400 lines.
    const content = Array.from({ length: 410 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const client = {
      didOpen: vi.fn(),
      documentSymbol: vi.fn().mockResolvedValue([{ name: 'Foo', kind: 5, line: 2, depth: 0 }]),
    };
    const registry = {
      activeClientFor: vi.fn().mockResolvedValue(client),
      languageIdForPath: vi.fn().mockReturnValue('typescript'),
    } as unknown as LspRegistry;
    // jianWithFiles has no readText; the outline build needs one.
    const jian = createFakeJian({
      ...jianWithFiles({ '/workspace/big.ts': content }),
      readText: vi.fn<Jian['readText']>().mockResolvedValue(content),
    });
    const tool = new ReadGroupTool(jian, { workspaceDir: '/workspace', additionalDirs: [] }, registry);

    const result = await executeTool(tool, context({ paths: ['/workspace/big.ts'] }));

    expect(result.isError).toBeFalsy();
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('Declarations (1): Class Foo — 3');
    expect(client.didOpen).toHaveBeenCalledWith('/workspace/big.ts', content, 'typescript');
  });

  it('leaves grouped reads unchanged when no registry is passed', async () => {
    const content = Array.from({ length: 410 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const jian = createFakeJian({
      ...jianWithFiles({ '/workspace/big.ts': content }),
      readText: vi.fn<Jian['readText']>().mockResolvedValue(content),
    });
    const tool = new ReadGroupTool(jian, { workspaceDir: '/workspace', additionalDirs: [] });

    const result = await executeTool(tool, context({ paths: ['/workspace/big.ts'] }));

    expect(result.isError).toBeFalsy();
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).not.toContain('Declarations');
  });
});
