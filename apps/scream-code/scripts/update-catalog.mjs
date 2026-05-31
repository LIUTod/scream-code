#!/usr/bin/env node
/**
 * Fetch the models.dev catalog and write it to a JSON file for release builds.
 *
 * Usage: node scripts/update-catalog.mjs --out <path>
 */
import { writeFileSync } from 'node:fs';

const DEFAULT_CATALOG_URL = 'https://models.dev/api.json';

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;

  if (!outPath) {
    console.error('Usage: node scripts/update-catalog.mjs --out <path>');
    process.exit(1);
  }

  console.error(`Fetching catalog from ${DEFAULT_CATALOG_URL}...`);
  const res = await fetch(DEFAULT_CATALOG_URL, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    console.error(`Failed to fetch catalog (HTTP ${res.status}).`);
    process.exit(1);
  }

  const catalog = await res.json();
  writeFileSync(outPath, JSON.stringify(catalog, null, 2));
  console.error(`Catalog written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
