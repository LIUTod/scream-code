import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import type {
  LspClient,
  LspDiagnostic,
  LspLocation,
  LspSymbolOutline,
  LspWorkspaceEdit,
} from '../../src/lsp/client';
import type { LspRegistry } from '../../src/lsp/registry';
import { LspInputSchema, LspTool } from '../../src/tools/builtin/lsp-tool';
import { createFakeJian, PERMISSIVE_WORKSPACE } from './fixtures/fake-jian';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function makeLspClient(overrides?: Partial<LspClient>): LspClient {
  return {
    didOpen: vi.fn(),
    references: vi.fn().mockResolvedValue([]),
    definition: vi.fn().mockResolvedValue([]),
    diagnostics: vi.fn().mockResolvedValue([]),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as LspClient;
}

function makeRegistry(client: LspClient | undefined, languageId = 'typescript'): LspRegistry {
  return {
    getClient: vi.fn().mockResolvedValue(client),
    languageIdForPath: vi.fn().mockReturnValue(client === undefined ? undefined : languageId),
    stopAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as LspRegistry;
}

function makeAgent(overrides?: {
  readText?: (path: string) => Promise<string>;
  writeText?: (path: string, content: string) => Promise<number>;
  capabilityMode?: 'all' | 'read-only' | 'read-write' | 'execute';
}): Agent {
  return {
    jian: createFakeJian({
      readText: overrides?.readText ?? vi.fn().mockResolvedValue('const x = 1;'),
      writeText: overrides?.writeText ?? vi.fn().mockResolvedValue(0),
    }),
    getCapabilityMode: () => overrides?.capabilityMode ?? 'all',
  } as unknown as Agent;
}

function context(args: Record<string, unknown>) {
  return { turnId: '0', toolCallId: 'call_lsp', args, signal };
}

describe('LspTool', () => {
  it('exposes current metadata and schema', () => {
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(makeLspClient()));

    expect(tool.name).toBe('LSP');
    expect(tool.description).toContain('language server');
    expect(tool.description).toContain('references');
    expect(LspInputSchema.safeParse({ path: '/tmp/a.ts', operation: 'diagnostics' }).success).toBe(true);
    expect(LspInputSchema.safeParse({ path: '/tmp/a.ts', operation: 'bad' }).success).toBe(false);
  });

  it('returns an error for unsupported file types', async () => {
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(undefined));

    const result = await executeTool(tool, context({ path: '/tmp/a.unknown', operation: 'diagnostics' }));

    expect(result.isError).toBe(true);
    expect(result.output).toContain('No language server configured');
  });

  it('refuses rename with apply in read-only capability mode, but previewing stays available', async () => {
    const tool = new LspTool(
      makeAgent({ capabilityMode: 'read-only' }),
      PERMISSIVE_WORKSPACE,
      makeRegistry(makeLspClient()),
    );
    const rename = {
      path: '/tmp/a.ts',
      operation: 'rename' as const,
      line: 1,
      character: 0,
      new_name: 'renamed',
    };

    await expect(tool.resolveExecution({ ...rename, apply: true })).rejects.toThrow(/read-only capability mode/);
    // The guard blocks the write only — previewing the rename still resolves.
    await expect(tool.resolveExecution({ ...rename, apply: false })).resolves.toBeDefined();
  });

  it('opens the file and returns references', async () => {
    const locations: LspLocation[] = [
      { uri: 'file:///tmp/b.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    ];
    const client = makeLspClient({ references: vi.fn().mockResolvedValue(locations) });
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const result = await executeTool(tool, context({
      path: '/tmp/a.ts',
      operation: 'references',
      line: 2,
      character: 5,
      include_declaration: true,
    }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('1 reference');
    expect(result.output).toContain('/tmp/b.ts:1:1');
    expect(client.didOpen).toHaveBeenCalledWith('/tmp/a.ts', 'const x = 1;', 'typescript');
    expect(client.references).toHaveBeenCalledWith('/tmp/a.ts', 1, 5, true);
  });

  it('opens the file and returns definitions', async () => {
    const locations: LspLocation[] = [
      { uri: 'file:///tmp/a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    ];
    const client = makeLspClient({ definition: vi.fn().mockResolvedValue(locations) });
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const result = await executeTool(tool, context({
      path: '/tmp/a.ts',
      operation: 'definition',
      line: 3,
      character: 10,
    }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('1 definition');
    expect(result.output).toContain('/tmp/a.ts:1:1');
    expect(client.definition).toHaveBeenCalledWith('/tmp/a.ts', 2, 10);
  });

  it('opens the file and returns diagnostics', async () => {
    const diagnostics: LspDiagnostic[] = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 1,
        message: 'Cannot find name',
      },
    ];
    const client = makeLspClient({ diagnostics: vi.fn().mockResolvedValue(diagnostics) });
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const result = await executeTool(tool, context({ path: '/tmp/a.ts', operation: 'diagnostics' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('1 diagnostic');
    expect(result.output).toContain('Cannot find name');
  });

  it('returns an error when references/definition are missing line or character', async () => {
    const client = makeLspClient();
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const refs = await executeTool(tool, context({ path: '/tmp/a.ts', operation: 'references', line: 1 }));
    expect(refs.isError).toBe(true);
    expect(refs.output).toContain("'references' requires both");

    const def = await executeTool(tool, context({ path: '/tmp/a.ts', operation: 'definition', character: 0 }));
    expect(def.isError).toBe(true);
    expect(def.output).toContain("'definition' requires both");
  });
});

describe('LspTool — readonly operations added in the 10-op surface', () => {
  it('accepts the new operations in the schema and still rejects unknown ones', () => {
    for (const operation of [
      'document_symbols',
      'hover',
      'type_definition',
      'implementation',
      'code_actions',
    ]) {
      expect(LspInputSchema.safeParse({ path: '/tmp/a.ts', operation }).success).toBe(true);
    }
    expect(LspInputSchema.safeParse({ path: '/tmp/a.ts', operation: 'rename' }).success).toBe(true);
    expect(LspInputSchema.safeParse({ path: '/tmp/a.ts', operation: 'bad' }).success).toBe(false);
  });

  it('renders a depth-indented document_symbols outline', async () => {
    const outline: LspSymbolOutline[] = [
      { name: 'Foo', kind: 5, line: 2, depth: 0 },
      { name: 'bar', kind: 6, line: 30, depth: 1 },
      { name: 'qux', kind: 8, line: 33, depth: 2 },
    ];
    const client = makeLspClient({ documentSymbol: vi.fn().mockResolvedValue(outline) });
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const result = await executeTool(tool, context({ path: '/tmp/a.ts', operation: 'document_symbols' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Found 3 symbol(s):');
    expect(result.output).toContain('Class Foo — 3');
    expect(result.output).toContain('  Method bar — 31');
    expect(result.output).toContain('    Field qux — 34');
    expect(client.didOpen).toHaveBeenCalledWith('/tmp/a.ts', 'const x = 1;', 'typescript');
    expect(client.documentSymbol).toHaveBeenCalledWith('/tmp/a.ts');
  });

  it('reports an empty document_symbols outline', async () => {
    const client = makeLspClient({ documentSymbol: vi.fn().mockResolvedValue([]) });
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const result = await executeTool(tool, context({ path: '/tmp/a.ts', operation: 'document_symbols' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('No symbols returned for this file.');
  });

  it('caps document_symbols at 200 entries with an "… and N more" trailer', async () => {
    const outline: LspSymbolOutline[] = Array.from({ length: 205 }, (_, i) => ({
      name: `sym${String(i)}`,
      kind: 12,
      line: i,
      depth: 0,
    }));
    const client = makeLspClient({ documentSymbol: vi.fn().mockResolvedValue(outline) });
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const result = await executeTool(tool, context({ path: '/tmp/a.ts', operation: 'document_symbols' }));
    const output = typeof result.output === 'string' ? result.output : '';

    expect(result.isError).toBeFalsy();
    expect(output).toContain('Found 205 symbol(s):');
    expect(output).toContain('… and 5 more');
    expect(output.endsWith('… and 5 more')).toBe(true);
    // The 200 rendered entries end right before the trailer.
    expect(output).toContain('Function sym199 — 200');
    expect(output).not.toContain('Function sym200');
  });

  it('returns hover contents with a range label', async () => {
    const client = makeLspClient({
      hover: vi.fn().mockResolvedValue({
        contents: 'Adds two numbers.',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
      }),
    });
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const result = await executeTool(tool, context({ path: '/tmp/a.ts', operation: 'hover', line: 1, character: 0 }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Adds two numbers.');
    expect(result.output).toContain('Range: 1:1-1:5');
    expect(client.hover).toHaveBeenCalledWith('/tmp/a.ts', 0, 0);
  });

  it('reports missing hover information and rejects hover without a position', async () => {
    const client = makeLspClient({ hover: vi.fn().mockResolvedValue(null) });
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const missing = await executeTool(tool, context({ path: '/tmp/a.ts', operation: 'hover' }));
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain("'hover' requires both 'line' and 'character'.");

    const nothing = await executeTool(
      tool,
      context({ path: '/tmp/a.ts', operation: 'hover', line: 3, character: 2 }),
    );
    expect(nothing.isError).toBeFalsy();
    expect(nothing.output).toBe('No hover information.');
    expect(client.hover).toHaveBeenCalledWith('/tmp/a.ts', 2, 2);
  });

  it('lists type_definition and implementation locations or reports no results', async () => {
    const locations: LspLocation[] = [
      { uri: 'file:///tmp/other.ts', range: { start: { line: 4, character: 0 }, end: { line: 4, character: 9 } } },
    ];
    const client = makeLspClient({
      typeDefinition: vi.fn().mockResolvedValue(locations),
      implementation: vi.fn().mockResolvedValue([]),
    });
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const typeDef = await executeTool(
      tool,
      context({ path: '/tmp/a.ts', operation: 'type_definition', line: 5, character: 2 }),
    );
    expect(typeDef.isError).toBeFalsy();
    expect(typeDef.output).toContain('Found 1 type definition(s):');
    expect(typeDef.output).toContain('/tmp/other.ts:5:1');
    expect(client.typeDefinition).toHaveBeenCalledWith('/tmp/a.ts', 4, 2);

    const impl = await executeTool(
      tool,
      context({ path: '/tmp/a.ts', operation: 'implementation', line: 5, character: 2 }),
    );
    expect(impl.isError).toBeFalsy();
    expect(impl.output).toBe('No results found.');

    const noArgs = await executeTool(tool, context({ path: '/tmp/a.ts', operation: 'type_definition' }));
    expect(noArgs.isError).toBe(true);
    expect(noArgs.output).toContain("'type_definition' requires both");
  });

  it('lists code actions with index, kind and first-edit range', async () => {
    const edit: LspWorkspaceEdit = {
      changes: {
        'file:///tmp/a.ts': [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: 'let' },
        ],
      },
    };
    const client = makeLspClient({
      codeActions: vi.fn().mockResolvedValue([
        { title: 'Convert to let', kind: 'quickfix', edit, index: 0 },
        { title: 'Run tests', index: 1 },
      ]),
    });
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const result = await executeTool(tool, context({ path: '/tmp/a.ts', operation: 'code_actions' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Found 2 code action(s):');
    expect(result.output).toContain('0. Convert to let — quickfix — 1:1-1:5');
    expect(result.output).toContain('1. Run tests');
    expect(client.codeActions).toHaveBeenCalledWith('/tmp/a.ts', 0, 0, Number.MAX_SAFE_INTEGER, 0);
  });

  it('filters code actions by kind prefix while keeping the server indices', async () => {
    const client = makeLspClient({
      codeActions: vi.fn().mockResolvedValue([
        { title: 'Extract function', kind: 'refactor.extract', index: 0 },
        { title: 'Fix spelling', kind: 'quickfix', index: 1 },
        { title: 'Inline variable', kind: 'refactor.inline', index: 2 },
      ]),
    });
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const result = await executeTool(
      tool,
      context({ path: '/tmp/a.ts', operation: 'code_actions', kinds: 'refactor' }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Found 2 code action(s):');
    expect(result.output).toContain('0. Extract function — refactor.extract');
    expect(result.output).toContain('2. Inline variable — refactor.inline');
    expect(result.output).not.toContain('Fix spelling');
    expect(client.codeActions).toHaveBeenCalledWith(
      '/tmp/a.ts',
      0,
      0,
      Number.MAX_SAFE_INTEGER,
      0,
    );
  });

  it('reports when no code actions are available', async () => {
    const client = makeLspClient({ codeActions: vi.fn().mockResolvedValue([]) });
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const result = await executeTool(tool, context({ path: '/tmp/a.ts', operation: 'code_actions' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('No code actions available for this range.');
  });

  it('applies a selected code action to disk with the same write gating as rename', async () => {
    // Range 0–5 covers the whole 'const' keyword of the fixture content.
    const edit: LspWorkspaceEdit = {
      changes: {
        'file:///tmp/a.ts': [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'let' },
        ],
      },
    };
    const client = makeLspClient({
      codeActions: vi.fn().mockResolvedValue([{ title: 'Convert to let', kind: 'quickfix', edit, index: 0 }]),
    });
    const writeText = vi.fn().mockResolvedValue(12);
    const tool = new LspTool(makeAgent({ writeText }), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const result = await executeTool(
      tool,
      context({ path: '/tmp/a.ts', operation: 'code_actions', apply_action: 0 }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('Applied action "Convert to let" to 1 file(s).');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.ts', 'let x = 1;');
    expect(client.codeActions).toHaveBeenCalledWith('/tmp/a.ts', 0, 0, Number.MAX_SAFE_INTEGER, 0);
  });

  it('errors cleanly when apply_action is out of range or the action carries no edit', async () => {
    const client = makeLspClient({
      codeActions: vi.fn().mockResolvedValue([
        { title: 'Run tests', index: 0 },
        { title: 'Nothing to do', index: 1 },
      ]),
    });
    const tool = new LspTool(makeAgent(), PERMISSIVE_WORKSPACE, makeRegistry(client));

    const outOfRange = await executeTool(
      tool,
      context({ path: '/tmp/a.ts', operation: 'code_actions', apply_action: 9 }),
    );
    expect(outOfRange.isError).toBe(true);
    expect(outOfRange.output).toContain('No code action with index 9');
    expect(outOfRange.output).toContain('re-run without');

    const noEdit = await executeTool(
      tool,
      context({ path: '/tmp/a.ts', operation: 'code_actions', apply_action: 1 }),
    );
    expect(noEdit.isError).toBe(true);
    expect(noEdit.output).toContain('Code action "Nothing to do" has no workspace edit to apply');
  });

  it('refuses code_actions apply in read-only capability mode but listing stays available', async () => {
    const tool = new LspTool(
      makeAgent({ capabilityMode: 'read-only' }),
      PERMISSIVE_WORKSPACE,
      makeRegistry(makeLspClient()),
    );
    const codeActions = { path: '/tmp/a.ts', operation: 'code_actions' as const };

    await expect(tool.resolveExecution({ ...codeActions, apply_action: 0 })).rejects.toThrow(
      /read-only capability mode/,
    );
    // The guard blocks the write only — listing the actions still resolves.
    await expect(tool.resolveExecution({ ...codeActions })).resolves.toBeDefined();
  });
});
