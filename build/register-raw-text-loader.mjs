import { register } from 'node:module';

/**
 * Registers the `.md` / `.yaml` raw-text loader. Pass to Node via `--import`
 * (alongside tsx) so source-executed code can import these prompt files.
 */
register('./raw-text-loader.mjs', import.meta.url);
