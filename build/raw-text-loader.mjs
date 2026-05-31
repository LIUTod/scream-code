import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Node ESM `load` hook: import `.md` / `.yaml` files as raw-string modules.
 *
 * This is the runtime counterpart of `build/raw-text-plugin.mjs` (the bundler
 * plugin). The plugin covers build (tsdown) and test (vitest); this loader
 * covers source execution — e.g. `tsx`-run dev flows that import `scream-core`
 * straight from `src`, where no bundler is involved.
 */
export async function load(url, context, nextLoad) {
  const filePath = url.split('?', 1)[0] ?? url;
  if (filePath.endsWith('.md') || filePath.endsWith('.yaml')) {
    const text = await readFile(fileURLToPath(filePath), 'utf-8');
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(text)};`,
    };
  }
  return nextLoad(url, context);
}
