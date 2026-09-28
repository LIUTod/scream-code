#!/usr/bin/env node
/**
 * App import-boundary guard (AGENTS.md boundary rule).
 *
 * apps/scream-code must use core capabilities only through
 * @scream-code/scream-code-sdk; app code must never import
 * @scream-code/agent-core (nor any of its subpaths) directly. This script
 * scans the app's source trees and fails CI when a direct core import
 * reappears, in any of its forms: static `from`, side-effect bare import,
 * dynamic `import()`, `require()`, and re-`export ... from` (covered by the
 * `from` branch). The pattern deliberately over-matches `agent-core/` and
 * `agent-core'` so subpath imports cannot slip through.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const APP_ROOTS = [
  'apps/scream-code/src',
  'apps/scream-code/test',
  'apps/scream-code/scripts',
];
const EXT = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.vue']);
// Stateless (no /g): a global regex would carry lastIndex across files and
// skip offenders whose match sits before the previous file's match point.
const BANNED =
  /(?:\bfrom\s*(?:\/\*[\s\S]*?\*\/\s*)*|\bimport\s*\(\s*|\bimport\s+(?:\/\*[\s\S]*?\*\/\s*)*|\brequire\s*\(\s*)['"]@scream-code\/agent-core(?:['"/])/;

const offenders = [];

function scan(path) {
  const text = readFileSync(path, 'utf8');
  if (BANNED.test(text)) offenders.push(relative(process.cwd(), path));
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
    } else {
      const dot = entry.name.lastIndexOf('.');
      if (dot >= 0 && EXT.has(entry.name.slice(dot))) scan(path);
    }
  }
}

for (const root of APP_ROOTS) walk(root);

// App-root config files live outside the trees above (e.g. tsdown.config.ts).
for (const name of readdirSync('apps/scream-code', { withFileTypes: true })) {
  if (name.isFile() && /\.(?:[cm]?[jt]s)$/.test(name.name)) {
    scan(join('apps/scream-code', name.name));
  }
}

if (offenders.length > 0) {
  console.error('Direct @scream-code/agent-core imports found in app code:');
  for (const file of offenders) console.error(`  ${file}`);
  console.error(
    'Route these through @scream-code/scream-code-sdk instead (see the boundary rule in AGENTS.md).',
  );
  process.exit(1);
}

console.log(`Import boundary OK: ${APP_ROOTS.length} trees + app-root configs, no direct core imports.`);
