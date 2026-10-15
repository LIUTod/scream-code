import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'knowledge',
    include: ['test/**/*.test.ts'],
    setupFiles: ['../../build/isolate-home.ts'],
  },
});
