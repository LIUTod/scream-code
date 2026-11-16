/**
 * `typescript-language-server` only speaks LSP; diagnostics come from the
 * `typescript` package's own tsserver, which it must be told where to find when
 * the project has none. The "bundled" typescript is a repo-checkout accident —
 * an installed CLI does not ship it — so the resolver has to find an install
 * the user already has: in the project or an ancestor, next to the language
 * server, or in the global prefix of the running Node.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveTsserverPath } from '#/lsp/registry';

let root: string;

function installTypescript(prefix: string): string {
  const lib = join(prefix, 'node_modules', 'typescript', 'lib');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'tsserver.js'), '// fake tsserver\n');
  return lib;
}

const NOTHING = { pathEnv: '', execPath: '/nonexistent/bin/node', bundled: () => undefined };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'scream-tsserver-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveTsserverPath', () => {
  it('uses the typescript installed in the workspace', () => {
    const workspace = join(root, 'proj');
    const lib = installTypescript(workspace);
    expect(resolveTsserverPath(workspace, NOTHING)).toBe(lib);
  });

  it('finds typescript hoisted into an ancestor of the workspace (monorepo package)', () => {
    const lib = installTypescript(root);
    const workspace = join(root, 'packages', 'app');
    mkdirSync(workspace, { recursive: true });
    expect(resolveTsserverPath(workspace, NOTHING)).toBe(lib);
  });

  it('prefers the closest install over a farther one', () => {
    installTypescript(root);
    const workspace = join(root, 'packages', 'app');
    const near = installTypescript(workspace);
    expect(resolveTsserverPath(workspace, NOTHING)).toBe(near);
  });

  it('finds typescript installed beside a globally installed language server on PATH', () => {
    const globalRoot = join(root, 'global', 'lib', 'node_modules');
    const serverPkg = join(globalRoot, 'typescript-language-server');
    mkdirSync(join(serverPkg, 'lib'), { recursive: true });
    writeFileSync(join(serverPkg, 'lib', 'cli.mjs'), '// fake server\n');
    const lib = join(globalRoot, 'typescript', 'lib');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, 'tsserver.js'), '// fake tsserver\n');
    const bin = join(root, 'global', 'bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync(join(serverPkg, 'lib', 'cli.mjs'), join(bin, 'typescript-language-server'));

    const workspace = join(root, 'empty-project');
    mkdirSync(workspace, { recursive: true });
    expect(resolveTsserverPath(workspace, { ...NOTHING, pathEnv: `/nowhere${delimiter}${bin}` })).toBe(
      lib,
    );
  });

  it('finds the Windows npm shim (`.cmd`) on PATH and the typescript beside it', () => {
    const prefix = join(root, 'win-prefix');
    mkdirSync(prefix, { recursive: true });
    // npm on Windows puts `typescript-language-server.cmd` in the prefix itself,
    // with node_modules next to it — there is no extensionless file to find.
    writeFileSync(join(prefix, 'typescript-language-server.cmd'), '@echo off\r\n');
    const lib = installTypescript(prefix);

    const workspace = join(root, 'empty-project');
    mkdirSync(workspace, { recursive: true });
    expect(resolveTsserverPath(workspace, { ...NOTHING, pathEnv: prefix })).toBe(lib);
  });

  it("finds typescript in the running Node's global prefix", () => {
    const prefix = join(root, 'node-prefix');
    const lib = join(prefix, 'lib', 'node_modules', 'typescript', 'lib');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, 'tsserver.js'), '// fake tsserver\n');
    mkdirSync(join(prefix, 'bin'), { recursive: true });

    const workspace = join(root, 'empty-project');
    mkdirSync(workspace, { recursive: true });
    expect(
      resolveTsserverPath(workspace, { ...NOTHING, execPath: join(prefix, 'bin', 'node') }),
    ).toBe(lib);
  });

  it('falls back to the bundled typescript last', () => {
    const workspace = join(root, 'empty-project');
    mkdirSync(workspace, { recursive: true });
    expect(resolveTsserverPath(workspace, { ...NOTHING, bundled: () => '/bundled/lib' })).toBe(
      '/bundled/lib',
    );
  });

  it('returns undefined when no typescript can be found anywhere', () => {
    const workspace = join(root, 'empty-project');
    mkdirSync(workspace, { recursive: true });
    expect(resolveTsserverPath(workspace, NOTHING)).toBeUndefined();
  });
});
