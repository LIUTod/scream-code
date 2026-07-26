/**
 * Copy web UI static assets into the build output.
 *
 * The web UI is a Vite + Vue3 SPA under src/web/frontend. Its build output
 * lands in dist/web-static. This script copies it to dist/public so that the
 * bundled HTTP server can serve index.html and the static assets.
 */

import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

await cp(
  join(__dirname, '../src/web/frontend/dist'),
  join(__dirname, '../dist/public'),
  { recursive: true, force: true },
);
