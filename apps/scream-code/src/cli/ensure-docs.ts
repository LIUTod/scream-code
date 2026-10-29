import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PRODUCT_MARKER = '.product-managed.json';

/**
 * Roots that may contain the shipped `docs/` directory, in lookup order:
 * - installed package: `<pkg>/dist` → `<pkg>/docs`
 * - repo build: `apps/scream-code/dist` → `<repo>/docs`
 * - source checkout: `apps/scream-code/src/cli` → `<repo>/docs`
 */
export function docsSourceCandidates(moduleDir: string): readonly string[] {
  return [
    join(moduleDir, '..', 'docs'),
    join(moduleDir, '..', '..', '..', 'docs'),
    join(moduleDir, '..', '..', '..', '..', 'docs'),
  ];
}

/** First candidate that actually contains the documentation. */
export function findDocsSource(moduleDir: string): string | undefined {
  return docsSourceCandidates(moduleDir).find((dir) => existsSync(join(dir, 'configuration.md')));
}

/** True when the directory was created by us and may be overwritten. */
export function isProductManaged(target: string): boolean {
  return existsSync(join(target, PRODUCT_MARKER));
}

/**
 * Copy the shipped product docs into the Scream home so the model can read them
 * from an absolute path that does not depend on the working directory.
 *
 * Idempotent for product-managed directories (an upgrade overwrites the
 * previous copy). A directory without our marker is treated as user-owned and
 * never touched — overwriting a colliding file name would silently destroy the
 * user's own edits.
 */
export function ensureDocsInstalled(homeDir: string, moduleDir: string): void {
  const source = findDocsSource(moduleDir);
  if (source === undefined) return;

  const target = join(homeDir, 'docs');
  if (existsSync(target) && !isProductManaged(target)) return;

  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
  writeFileSync(join(target, PRODUCT_MARKER), JSON.stringify({ managedBy: 'scream-code' }));
}
