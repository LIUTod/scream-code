import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  plugins: [rawTextPlugin()],
  resolve: {
    alias: {
      '@scream-code/scream-code-sdk': fileURLToPath(
        new URL('../node-sdk/src/index.ts', import.meta.url),
      ),
      '@scream-code/agent-core': fileURLToPath(
        new URL('../agent-core/src/index.ts', import.meta.url),
      ),
      '@scream-code/config': fileURLToPath(
        new URL('../config/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['src/**/*.eval.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
