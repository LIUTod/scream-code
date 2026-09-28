#!/usr/bin/env node
/**
 * App import-boundary guard (AGENTS.md boundary rule).
 *
 * apps/scream-code must use core capabilities only through
 * @scream-code/scream-code-sdk; app code must never import
 * @scream-code/agent-core directly. This script scans the app's src and
 * test trees and fails CI when a direct core import reappears.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const APP_ROOTS = ['apps/scream-code/src', 'apps/scream-code/test'];
const EXT = new Set(['.ts', '.tsx', '.mts']);
const BANNED = /(?:from\s+|import\s*\(\s*)['"]@scream-code\/agent-core['"]/g;

const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
    } else if (EXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      const text = readFileSync(path, 'utf8');
      if (BANNED.test(text)) offenders.push(relative(process.cwd(), path));
    }
  }
}

for (const root of APP_ROOTS) walk(root);

if (offenders.length > 0) {
  console.error('Direct @scream-code/agent-core imports found in app code:');
  for (const file of offenders) console.error(`  ${file}`);
  console.error(
    'Route these through @scream-code/scream-code-sdk instead (see the boundary rule in AGENTS.md).',
  );
  process.exit(1);
}

console.log(`Import boundary OK: ${APP_ROOTS.length} trees, no direct core imports.`);
