import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'jian',
    include: ['test/**/*.test.ts'],
    setupFiles: ['../../build/isolate-home.ts', './test/setup.ts'],
  },
});
