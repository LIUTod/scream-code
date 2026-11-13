import type { Jian } from '@scream-code/jian';
import { describe, expect, it, vi } from 'vitest';

import type { LspDiagnostic } from '../../src/lsp/client';
import type { LspRegistry } from '../../src/lsp/registry';
import {
  DIAGNOSTICS_TIMEOUT_MS,
  fetchDiagnostics,
  formatDiagnosticsHint,
  formatDiagnosticsNotice,
  hasErrors,
  type DiagnosticsResult,
} from '../../src/tools/builtin/file/lsp-diagnostics';
import { createFakeJian } from './fixtures/fake-jian';

const TS_SERVER_COMMAND = ['typescript-language-server', '--stdio'];

function makeDiagnostic(
  overrides: Partial<LspDiagnostic> = {},
): LspDiagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    severity: 1,
    message: 'Type error',
    ...overrides,
  };
}

function fakeLspClient(
  diagnostics: LspDiagnostic[],
  opts?: { throwOnDiag?: Error; observed?: boolean },
): {
  didOpen: ReturnType<typeof vi.fn>;
  didChange: ReturnType<typeof vi.fn>;
  diagnosticsReport: ReturnType<typeof vi.fn>;
} {
  const report = opts?.throwOnDiag
    ? vi.fn().mockRejectedValue(opts.throwOnDiag)
    : vi.fn().mockResolvedValue({ diagnostics, observed: opts?.observed ?? true });
  return {
    didOpen: vi.fn(),
    didChange: vi.fn(),
    diagnosticsReport: report,
  };
}

interface FakeRegistryOptions {
  readonly client?: ReturnType<typeof fakeLspClient> | undefined;
  readonly languageId?: string;
  readonly command?: string[];
  readonly clientError?: Error;
}

function fakeRegistry(opts: FakeRegistryOptions = {}): LspRegistry {
  const { client, languageId = 'typescript', command = TS_SERVER_COMMAND, clientError } = opts;
  return {
    getClient: clientError
      ? vi.fn().mockRejectedValue(clientError)
      : vi.fn().mockResolvedValue(client),
    languageIdForPath: vi.fn().mockReturnValue(languageId),
    commandForPath: vi.fn().mockReturnValue(command),
    stopAll: vi.fn(),
  } as unknown as LspRegistry;
}

function fakeJianWithContent(content: string): Jian {
  return createFakeJian({ readText: vi.fn().mockResolvedValue(content) });
}

describe('fetchDiagnostics', () => {
  it('returns unsupported when registry is undefined', async () => {
    const result = await fetchDiagnostics(undefined, fakeJianWithContent('x'), '/a.ts', '/ws');
    expect(result.available).toBe(false);
    expect(result.reason).toBe('unsupported');
    expect(result.diagnostics).toEqual([]);
  });

  it('returns unsupported when language id is not supported', async () => {
    const registry = fakeRegistry({ languageId: undefined as unknown as string });
    const result = await fetchDiagnostics(registry, fakeJianWithContent('x'), '/a.md', '/ws');
    expect(result.available).toBe(false);
    expect(result.reason).toBe('unsupported');
  });

  it('returns unsupported when getClient returns undefined', async () => {
    const registry = fakeRegistry({ client: undefined });
    const result = await fetchDiagnostics(registry, fakeJianWithContent('x'), '/a.ts', '/ws');
    expect(result.available).toBe(false);
    expect(result.reason).toBe('unsupported');
  });

  it('returns server-missing with command name when getClient throws', async () => {
    const registry = fakeRegistry({ clientError: new Error('ENOENT') });
    const result = await fetchDiagnostics(registry, fakeJianWithContent('x'), '/a.ts', '/ws');
    expect(result.available).toBe(false);
    expect(result.reason).toBe('server-missing');
    expect(result.serverCommand).toBe('typescript-language-server');
  });

  it('reads file content, calls didOpen, then returns diagnostics', async () => {
    const diags = [makeDiagnostic({ message: 'oops' })];
    const client = fakeLspClient(diags);
    const registry = fakeRegistry({ client });
    const jian = fakeJianWithContent('const x: number = "bad";');

    const result = await fetchDiagnostics(registry, jian, '/a.ts', '/ws');

    expect(result.available).toBe(true);
    expect(result.observed).toBe(true);
    expect(result.diagnostics).toEqual(diags);
    expect(result.reason).toBeUndefined();
    expect(jian.readText).toHaveBeenCalledWith('/a.ts');
    expect(client.didOpen).toHaveBeenCalledWith(
      '/a.ts',
      'const x: number = "bad";',
      'typescript',
    );
    expect(client.diagnosticsReport).toHaveBeenCalledWith('/a.ts', DIAGNOSTICS_TIMEOUT_MS);
  });

  it('reports observed=false when the poll times out without a publication', async () => {
    // The client answers { diagnostics: [], observed: false } after its poll
    // loop expires: an empty list that carries no information.
    const registry = fakeRegistry({ client: fakeLspClient([], { observed: false }) });
    const result = await fetchDiagnostics(registry, fakeJianWithContent('x'), '/a.ts', '/ws');
    expect(result.available).toBe(true);
    expect(result.observed).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });

  it('reports observed=true when the server publishes an empty list', async () => {
    const registry = fakeRegistry({ client: fakeLspClient([], { observed: true }) });
    const result = await fetchDiagnostics(registry, fakeJianWithContent('x'), '/a.ts', '/ws');
    expect(result.observed).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.hasErrors).toBe(false);
  });

  it('returns available=true with observed=false when client.diagnosticsReport throws', async () => {
    const client = fakeLspClient([], { throwOnDiag: new Error('timeout') });
    const registry = fakeRegistry({ client });
    const result = await fetchDiagnostics(registry, fakeJianWithContent('x'), '/a.ts', '/ws');
    expect(result.available).toBe(true);
    expect(result.observed).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });

  it('returns available=true with observed=false when readText throws', async () => {
    const client = fakeLspClient([]);
    const registry = fakeRegistry({ client });
    const jian = createFakeJian({ readText: vi.fn().mockRejectedValue(new Error('io')) });
    const result = await fetchDiagnostics(registry, jian, '/a.ts', '/ws');
    expect(result.available).toBe(true);
    expect(result.observed).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(client.didOpen).not.toHaveBeenCalled();
  });
});

describe('formatDiagnosticsNotice', () => {
  it('returns empty string when LSP was unavailable', () => {
    expect(formatDiagnosticsNotice({ available: false, observed: false, diagnostics: [], hasErrors: false })).toBe('');
  });

  it('returns empty string when no diagnostics', () => {
    expect(formatDiagnosticsNotice({ available: true, observed: true, diagnostics: [], hasErrors: false })).toBe('');
  });

  it('formats header and each diagnostic line', () => {
    const diags = [
      makeDiagnostic({ severity: 1, message: 'Cannot find name foo', range: { start: { line: 4, character: 3 }, end: { line: 4, character: 6 } } }),
      makeDiagnostic({ severity: 2, message: 'Unused var', range: { start: { line: 9, character: 0 }, end: { line: 9, character: 5 } } }),
    ];
    const out = formatDiagnosticsNotice({ available: true, observed: true, diagnostics: diags, hasErrors: true });
    expect(out).toBe(
      '[LSP] 2 diagnostic(s):\n' +
      '- Error at 5:4: Cannot find name foo\n' +
      '- Warning at 10:1: Unused var',
    );
  });

  it('appends "… (N more)" when exceeding 8 diagnostics', () => {
    const diags = Array.from({ length: 10 }, (_, i) =>
      makeDiagnostic({ message: `err ${i}`, range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } } }),
    );
    const out = formatDiagnosticsNotice({ available: true, observed: true, diagnostics: diags, hasErrors: true });
    expect(out).toContain('[LSP] 10 diagnostic(s):');
    expect(out).toContain('… (2 more)');
    expect(out.split('\n').length).toBe(1 + 8 + 1);
  });

  it('does not append more hint when exactly 8 diagnostics', () => {
    const diags = Array.from({ length: 8 }, (_, i) =>
      makeDiagnostic({ message: `err ${i}` }),
    );
    const out = formatDiagnosticsNotice({ available: true, observed: true, diagnostics: diags, hasErrors: true });
    expect(out).not.toContain('more)');
  });
});

describe('hasErrors', () => {
  it('returns true when any diagnostic has severity 1 (Error)', () => {
    const diags: LspDiagnostic[] = [
      makeDiagnostic({ severity: 1 }),
      makeDiagnostic({ severity: 2 }),
    ];
    expect(hasErrors(diags)).toBe(true);
  });

  it('returns false when no diagnostic has severity 1', () => {
    const diags: LspDiagnostic[] = [
      makeDiagnostic({ severity: 2 }),
      makeDiagnostic({ severity: 3 }),
    ];
    expect(hasErrors(diags)).toBe(false);
  });

  it('returns false for an empty diagnostics array', () => {
    expect(hasErrors([])).toBe(false);
  });

  it('returns false when severity is undefined', () => {
    const diags: LspDiagnostic[] = [
      makeDiagnostic({ severity: undefined }),
    ];
    expect(hasErrors(diags)).toBe(false);
  });
});

describe('formatDiagnosticsHint', () => {
  it('returns empty string for unsupported file types', () => {
    const result: DiagnosticsResult = { available: false, observed: false, diagnostics: [], hasErrors: false, reason: 'unsupported' };
    expect(formatDiagnosticsHint(result)).toBe('');
  });

  it('returns empty string when LSP started successfully', () => {
    const result: DiagnosticsResult = { available: true, observed: true, diagnostics: [], hasErrors: false };
    expect(formatDiagnosticsHint(result)).toBe('');
  });

  it('returns empty string when server is missing but command is unknown', () => {
    const result: DiagnosticsResult = {
      available: false,
      observed: false,
      diagnostics: [],
      hasErrors: false,
      reason: 'server-missing',
      serverCommand: undefined,
    };
    expect(formatDiagnosticsHint(result)).toBe('');
  });

  it('returns a Chinese install hint naming the missing server command', () => {
    const result: DiagnosticsResult = {
      available: false,
      observed: false,
      diagnostics: [],
      hasErrors: false,
      reason: 'server-missing',
      serverCommand: 'typescript-language-server',
    };
    const hint = formatDiagnosticsHint(result);
    expect(hint).toContain('提示');
    expect(hint).toContain('typescript-language-server');
    expect(hint.startsWith('\n')).toBe(true);
  });

  it('names pyright-langserver for python files', () => {
    const result: DiagnosticsResult = {
      available: false,
      observed: false,
      diagnostics: [],
      hasErrors: false,
      reason: 'server-missing',
      serverCommand: 'pyright-langserver',
    };
    expect(formatDiagnosticsHint(result)).toContain('pyright-langserver');
  });
});
