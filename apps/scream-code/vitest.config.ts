import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [rawTextPlugin()],
        test: {
          name: 'cli',
          include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
          setupFiles: ['test/global-setup.ts'],
        },
      },
    ],
  },
});
