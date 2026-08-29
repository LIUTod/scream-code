import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

const appRoot = import.meta.dirname;

export default defineConfig({
  plugins: [rawTextPlugin(), vue()],
  resolve: {
    alias: {
      '@': resolve(appRoot, 'src'),
    },
  },
  test: {
    name: 'cli',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['test/global-setup.ts'],
  },
});
