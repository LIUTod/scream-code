import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ltod',
    include: ['test/**/*.test.ts'],
    setupFiles: ['../../build/isolate-home.ts'],
  },
});
