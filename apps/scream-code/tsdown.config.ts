import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';
import { BUILT_IN_CATALOG_DEFINE, builtInCatalogDefine } from './scripts/built-in-catalog.mjs';

const appRoot = import.meta.dirname;
const repoRoot = resolve(appRoot, '../..');
const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string };

function buildTarget(): string {
  return process.env['SCREAM_CODE_BUILD_TARGET'] ?? `${process.platform}-${process.arch}`;
}

export default defineConfig({
  entry: ['./src/main.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';",
      "import { dirname as __cjsShimDirname } from 'node:path';",
      'const __filename = __cjsShimFileURLToPath(import.meta.url);',
      'const __dirname = __cjsShimDirname(__filename);',
    ].join('\n'),
  },
  plugins: [rawTextPlugin()],
  alias: {
    '@': resolve(appRoot, 'src'),
    '@scream-code/memory': resolve(repoRoot, 'packages/memory/src/index.ts'),
  },
  define: {
    [BUILT_IN_CATALOG_DEFINE]: builtInCatalogDefine(),
    __SCREAM_CODE_VERSION__: JSON.stringify(packageJson.version),
    __SCREAM_CODE_CHANNEL__: JSON.stringify(process.env['SCREAM_CODE_CHANNEL'] ?? ''),
    __SCREAM_CODE_COMMIT__: JSON.stringify(process.env['SCREAM_CODE_COMMIT'] ?? ''),
    __SCREAM_CODE_BUILD_TARGET__: JSON.stringify(buildTarget()),
  },
  deps: {
    alwaysBundle: [/^@scream-./],
    // mupdf must resolve its mupdf-wasm.wasm sibling from its own package
    // directory at runtime; bundling the JS breaks that lookup.
    neverBundle: ['fastembed', 'mupdf'],
  },
});
