import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'scream-telemetry',
    include: ['test/**/*.test.ts'],
  },
});
