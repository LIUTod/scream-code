/**
 * Advice for a language server that failed to start, keyed on what it said.
 *
 * Most start failures mean the server binary is not installed, and that is the
 * default hint. The TypeScript server is the exception worth naming: it can be
 * installed and still refuse to start because it cannot find the `typescript`
 * package it drives, and telling that user to install the server again is wrong.
 */
const TYPESCRIPT_MISSING = /valid TypeScript installation/i;

export function lspStartFailureHint(message: string): string | undefined {
  if (TYPESCRIPT_MISSING.test(message)) {
    return (
      '`typescript-language-server` is installed but cannot find the `typescript` package it needs. ' +
      'Install it with `npm i -g typescript` (or `npm i -D typescript` in the project) and restart the session.'
    );
  }
  return undefined;
}
