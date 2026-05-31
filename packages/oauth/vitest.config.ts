import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'scream-oauth',
    include: ['test/**/*.test.ts'],
  },
});
