import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  plugins: [rawTextPlugin()],
  deps: {
    alwaysBundle: ['picomatch'],
    neverBundle: ['@scream-cli/ltod', '@scream-cli/jian'],
  },
});
