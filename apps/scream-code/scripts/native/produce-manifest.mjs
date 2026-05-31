#!/usr/bin/env node
/**
 * Produce a manifest.json for native release artifacts.
 * Currently a no-op — native builds are not yet enabled in v0.3.0.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main() {
  const [_node, _script, outDir, releaseTag] = process.argv;

  if (!outDir || !releaseTag) {
    console.error('Usage: node produce-manifest.mjs <out-dir> <release-tag>');
    process.exit(1);
  }

  // Placeholder: write an empty manifest so the workflow step succeeds.
  const manifest = {
    version: releaseTag.replace(/^v/, ''),
    tag: releaseTag,
    artifacts: [],
    note: 'Native builds are not yet enabled in v0.3.0.',
  };

  writeFileSync(
    resolve(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  console.log(`Manifest written to ${resolve(outDir, 'manifest.json')}`);
}

main();
