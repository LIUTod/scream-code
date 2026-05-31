#!/usr/bin/env node
/**
 * Resolve whether a native release should be published.
 * Currently returns false — native builds are not yet enabled in v0.3.0.
 */
import { appendFileSync } from 'node:fs';

function main() {
  const publishedPackages = process.env.CHANGESETS_PUBLISHED_PACKAGES;
  const packages = publishedPackages ? JSON.parse(publishedPackages) : [];

  const hasScreamCode = packages.some(
    (pkg) => pkg.name === '@scream-cli/scream-code',
  );

  // Native builds disabled for v0.3.0 initial release.
  // Flip to `hasScreamCode` when native artifact pipeline is ready.
  const shouldPublish = false;

  const tag = hasScreamCode && packages[0]?.version
    ? `v${packages[0].version}`
    : '';

  console.log(`should_publish=${shouldPublish}`);
  console.log(`tag=${tag}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `should_publish=${shouldPublish}\ntag=${tag}\n`,
    );
  }
}

main();
