import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  // `resume.integration.test.ts` imports real scream-core (`Session`), which
  // transitively imports `.md` / `.yaml` prompt sources as raw strings.
  // Reuse the same plugin scream-core uses so those imports resolve identically.
  plugins: [rawTextPlugin()],
  test: {
    name: 'migration-legacy',
    include: ['test/**/*.test.ts'],
  },
});
