import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const appRoot = import.meta.dirname;

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: {
      '@': resolve(appRoot, 'src/bot/ui'),
    },
  },
  test: {
    name: 'bot-ui',
    include: ['test/bot/ui/**/*.dom.test.tsx'],
    environment: 'jsdom',
    setupFiles: ['test/global-setup.ts'],
  },
});
