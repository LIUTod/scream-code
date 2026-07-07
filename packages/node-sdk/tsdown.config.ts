import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: false,
  outDir: 'dist',
  clean: true,
  plugins: [rawTextPlugin()],
  banner: {
    js: [
      "import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';",
      "import { dirname as __cjsShimDirname } from 'node:path';",
      'const __filename = __cjsShimFileURLToPath(import.meta.url);',
      'const __dirname = __cjsShimDirname(__filename);',
    ].join('\n'),
  },
  alias: {
    '@scream-code/agent-core': fileURLToPath(new URL('../agent-core/src/index.ts', import.meta.url)),
    '@scream-code/jian': fileURLToPath(new URL('../jian/src/index.ts', import.meta.url)),
    '@scream-code/config': fileURLToPath(new URL('../config/src/index.ts', import.meta.url)),
    '@scream-code/ltod': fileURLToPath(new URL('../ltod/src/index.ts', import.meta.url)),
  },
  deps: {
    alwaysBundle: [/^@scream-./],
    neverBundle: ['fastembed'],
  },
});
