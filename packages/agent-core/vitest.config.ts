import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  plugins: [rawTextPlugin()],
  test: {
    name: 'scream-core',
    include: ['test/**/*.{test,e2e}.ts'],
  },
});
