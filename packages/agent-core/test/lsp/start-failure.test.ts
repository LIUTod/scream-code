/**
 * When the TypeScript language server starts but cannot find the `typescript`
 * package, the old hint told people to install the language server — which they
 * already had. The failure text decides which advice is true.
 */
import { describe, expect, it } from 'vitest';

import { lspStartFailureHint } from '#/lsp/start-failure';

describe('lspStartFailureHint', () => {
  it('recognizes the missing-typescript failure and names the real fix', () => {
    const hint = lspStartFailureHint(
      'Request initialize failed with message: Could not find a valid TypeScript installation. ' +
        'Please ensure that the "typescript" dependency is installed in the workspace or that a valid `tsserver.path` is specified.',
    );
    expect(hint).toContain('npm i -g typescript');
    expect(hint).toContain('typescript-language-server');
  });

  it('has no advice for failures it does not recognize', () => {
    expect(lspStartFailureHint('spawn rust-analyzer ENOENT')).toBeUndefined();
    expect(lspStartFailureHint('')).toBeUndefined();
  });
});

describe('missing language servers', () => {
  it('names the command that installs a known server', async () => {
    const { lspMissingServerHint, lspStartFailureHint } = await import('../../src/lsp/start-failure');
    expect(lspMissingServerHint('gopls')).toContain('go install golang.org/x/tools/gopls@latest');
    expect(lspMissingServerHint('pyright-langserver')).toContain('npm i -g pyright');
    expect(lspStartFailureHint('spawn rust-analyzer ENOENT', 'rust-analyzer')).toContain('rustup component add rust-analyzer');
    expect(lspStartFailureHint("'gopls' is not recognized as an internal or external command", 'gopls')).toContain('go install');
    expect(lspMissingServerHint('some-ls')).toContain('must be on PATH');
    expect(lspStartFailureHint('crashed with code 1', 'gopls')).toBeUndefined();
  });
});

