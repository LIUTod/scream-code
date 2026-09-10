import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  plugins: [rawTextPlugin()],
  test: {
    name: 'scream-core',
    include: ['test/**/*.{test,e2e}.ts'],
    setupFiles: ['./test/setup.ts'],
    // Heavy integration tests (real subagent turns, RLM kernels, spawned
    // processes) legitimately take seconds; under full-suite parallelism the
    // default 5s budget flakes. 15s is a ceiling, not a target — unit tests
    // still finish in milliseconds.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
