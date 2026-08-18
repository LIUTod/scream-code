import path from 'node:path';

/**
 * The npm global prefix the running Scream Code was installed into, derived
 * from the entry script path. Example:
 *
 *   /Users/tod/.npm-global/lib/node_modules/scream-code/dist/main.mjs
 *   → prefix /Users/tod/.npm-global
 *
 * `npm install -g` without `--prefix` uses the user's configured npm prefix,
 * which may point at a root-owned directory (e.g. /usr/local) and fail with
 * EACCES even though Scream Code itself lives in a user-writable prefix.
 * Returns undefined when the layout is unrecognized — the install then falls
 * back to the default prefix behavior.
 */
export function globalPrefixForScream(): string | undefined {
  const entry = process.argv[1];
  if (!entry) return undefined;
  const parts = entry.split(path.sep);
  const idx = parts.lastIndexOf('node_modules');
  if (idx < 2 || parts[idx - 1] !== 'lib') return undefined;
  return parts.slice(0, idx - 1).join(path.sep);
}

/**
 * Build the `npm install -g scream-code@latest` argument list, adding
 * `--prefix` when the running Scream Code's global directory can be resolved.
 */
export function installLatestArgs(): string[] {
  const prefix = globalPrefixForScream();
  return [
    'install',
    '-g',
    'scream-code@latest',
    ...(prefix !== undefined ? ['--prefix', prefix] : []),
  ];
}
