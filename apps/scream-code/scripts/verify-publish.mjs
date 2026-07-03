#!/usr/bin/env node
/**
 * prepublishOnly — sync README and verify dist version before npm publish.
 *
 * History: 0.7.8 shipped with dist built from 0.7.7 source (tsdown injects
 * __SCREAM_CODE_VERSION__ at build time, so stale dist = wrong --version to
 * users). This script rebuilds dist and asserts the injected version matches
 * package.json, failing the publish if not.
 *
 * Run automatically by `npm publish` / `pnpm publish` via the
 * `prepublishOnly` script hook. Run manually with `node scripts/verify-publish.mjs`.
 */
import { copyFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
const expected = pkg.version;

console.log(`[verify-publish] Expected version: ${expected}`);

// Step 0 — sync README from repo root into package dir.
// Single source of truth: repo-root README.md. The package-local copy is
// regenerated on each publish so npmjs.com matches GitHub without drift.
const repoRoot = resolve(pkgRoot, '../..');
const srcReadme = join(repoRoot, 'README.md');
const dstReadme = join(pkgRoot, 'README.md');
if (!existsSync(srcReadme)) {
  console.error(`[verify-publish] FAIL: repo-root README.md not found at ${srcReadme}`);
  process.exit(1);
}
copyFileSync(srcReadme, dstReadme);
console.log('[verify-publish] Synced README.md from repo root to package dir.');

// Step 1 — rebuild dist so __SCREAM_CODE_VERSION__ is freshly injected.
console.log('[verify-publish] Rebuilding dist via tsdown...');
execSync('pnpm exec tsdown', { stdio: 'inherit', cwd: pkgRoot });

// Step 2 — locate dist.
const distDir = join(pkgRoot, 'dist');
if (!existsSync(distDir)) {
  console.error(`[verify-publish] FAIL: dist directory not found at ${distDir}`);
  process.exit(1);
}

// Step 3 — scan all .mjs files for SCREAM_BUILD_INFO.version injection.
//    `optionalBuildString("<version>")` is the call site in build-info.ts:20
//    that receives `__SCREAM_CODE_VERSION__` from tsdown's `define`.
const mjsFiles = readdirSync(distDir).filter((f) => f.endsWith('.mjs'));
if (mjsFiles.length === 0) {
  console.error('[verify-publish] FAIL: no .mjs files in dist');
  process.exit(1);
}

const staleVersions = [];
let foundExpected = false;
const buildInfoRe = /optionalBuildString\("(\d+\.\d+\.\d+)"\)/g;

for (const file of mjsFiles) {
  const content = readFileSync(join(distDir, file), 'utf-8');
  for (const match of content.matchAll(buildInfoRe)) {
    const v = match[1];
    if (v === expected) {
      foundExpected = true;
    } else {
      staleVersions.push(`${file}: ${v}`);
    }
  }
}

if (!foundExpected) {
  console.error(
    `[verify-publish] FAIL: dist does not contain SCREAM_BUILD_INFO.version = "${expected}". ` +
      `This means tsdown's __SCREAM_CODE_VERSION__ define was not injected correctly. ` +
      `Check tsdown.config.ts and package.json version.`,
  );
  process.exit(1);
}

if (staleVersions.length > 0) {
  console.error(`[verify-publish] FAIL: stale version refs in dist:`);
  for (const s of staleVersions) console.error(`  ${s}`);
  process.exit(1);
}

console.log(`[verify-publish] OK: dist version matches ${expected} across ${String(mjsFiles.length)} .mjs files.`);
