import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'memory',
    include: ['test/**/*.test.ts'],
  },
});
