import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from './build/raw-text-plugin.mjs';

const workspaceRoot = import.meta.dirname;

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      {
        plugins: [rawTextPlugin()],
        resolve: {
          alias: {
            '@': resolve(workspaceRoot, 'apps/scream-code/src'),
          },
        },
        test: {
          name: 'cli',
          include: ['apps/scream-code/test/**/*.test.ts', 'apps/scream-code/test/**/*.test.tsx'],
          exclude: ['apps/scream-code/test/bot/ui/**/*.dom.test.tsx'],
          setupFiles: ['apps/scream-code/test/global-setup.ts'],
        },
      },
      'apps/scream-code/vitest.bot-ui.config.ts',
    ],
    coverage: {
      provider: 'v8',
      // Keep the generated report out of the repository root; it is a build
      // artifact, not source. It still lands in the workspace cache so it can
      // be opened locally after a run.
      reportsDirectory: 'node_modules/.cache/coverage',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/dist/**'],
      reporter: ['text', 'html'],
      thresholds: {
        statements: 62,
        branches: 56,
        functions: 66,
        lines: 64,
      },
    },
  },
});
