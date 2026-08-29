/**
 * Copy web UI static assets into the build output.
 *
 * The web UI is a Vite + Vue3 SPA under src/web/frontend. Its build output
 * lands in dist/web-static. This script copies it to dist/public so that the
 * bundled HTTP server can serve index.html and the static assets.
 */

import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Vite emits content-hashed filenames, so a plain copy leaves every previous
// build's chunks behind (a stale 300KB logo shipped alongside the new one).
// Clear the hashed asset dir before copying; other files in dist/public (if
// any are added later by hand) stay untouched.
const targetAssets = join(__dirname, '../dist/public/assets');
await rm(targetAssets, { recursive: true, force: true });

await cp(
  join(__dirname, '../src/web/frontend/dist'),
  join(__dirname, '../dist/public'),
  { recursive: true, force: true },
);
