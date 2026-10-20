import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/scream-code'],
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
