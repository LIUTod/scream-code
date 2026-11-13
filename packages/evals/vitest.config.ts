import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

/**
 * Unit-test project for packages/evals. Picked up by the root `vitest run`
 * through the `packages/*` project glob, so these tests run in the standard
 * repo gates. The real-model evals live in `vitest.eval.config.ts`
 * (eval files under `src/`, gated on SCREAM_EVAL_MODEL) and are never run
 * here.
 */
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
    name: 'evals',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
