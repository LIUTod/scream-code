/**
 * Advice for a language server that failed to start, keyed on what it said.
 *
 * Most start failures mean the server binary is not installed, and that is the
 * default hint. The TypeScript server is the exception worth naming: it can be
 * installed and still refuse to start because it cannot find the `typescript`
 * package it drives, and telling that user to install the server again is wrong.
 */
const TYPESCRIPT_MISSING = /valid TypeScript installation/i;

/** Not on PATH: spawn's ENOENT, or a shell's "not found" / "not recognized". */
const NOT_FOUND = /ENOENT|not found|is not recognized|no such file/i;

/**
 * How to install each supported server, the way most people already have the
 * toolchain: npm for the JavaScript/Python servers, the language's own tool for
 * Go and Rust. Each line works on macOS, Linux and Windows.
 */
const INSTALL: Readonly<Record<string, string>> = {
  'typescript-language-server': 'npm i -g typescript-language-server typescript',
  'pyright-langserver': 'npm i -g pyright',
  'rust-analyzer': 'rustup component add rust-analyzer',
  gopls: 'go install golang.org/x/tools/gopls@latest',
};

/** The hint for a server that is not installed: what it gives, and the command that installs it. */
export function lspMissingServerHint(server: string): string {
  const install = INSTALL[server];
  return install === undefined
    ? `Install the language server \`${server}\` (it must be on PATH) to get type and syntax diagnostics after edits.`
    : `The language server \`${server}\` is not installed, so edits get no type or syntax check. Install it with \`${install}\`, then restart the session (or tell the person the command if you may not run installs).`;
}

export function lspStartFailureHint(message: string, server?: string): string | undefined {
  if (TYPESCRIPT_MISSING.test(message)) {
    return (
      '`typescript-language-server` is installed but cannot find the `typescript` package it needs. ' +
      'Install it with `npm i -g typescript` (or `npm i -D typescript` in the project) and restart the session.'
    );
  }
  if (server !== undefined && NOT_FOUND.test(message)) return lspMissingServerHint(server);
  return undefined;
}
