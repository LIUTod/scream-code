/**
 * Copy web UI static assets into the build output.
 *
 * tsdown only compiles TypeScript; files under src/web/public are left behind.
 * This script copies them into dist/web/public so that the HTTP server can
 * serve index.html from the bundled package.
 */

import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

await cp(
  join(__dirname, '../src/web/public'),
  join(__dirname, '../dist/public'),
  { recursive: true, force: true },
);
