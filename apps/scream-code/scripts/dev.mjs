#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startPluginMarketplaceServer } from './dev-plugin-marketplace-server.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, '..');
const MARKETPLACE_ENV = 'SCREAM_CODE_PLUGIN_MARKETPLACE_URL';

let marketplaceServer;
const env = { ...process.env };

if (env[MARKETPLACE_ENV] === undefined || env[MARKETPLACE_ENV]?.trim().length === 0) {
  marketplaceServer = await startPluginMarketplaceServer();
  env[MARKETPLACE_ENV] = marketplaceServer.marketplaceUrl;
  console.error(`Plugin marketplace dev server: ${marketplaceServer.marketplaceUrl}`);
}

// The `tsx` CLI is run through this process's own Node binary rather than
// through the `tsx` bin shim. On Windows that shim is `tsx.cmd`, and Node
// refuses to spawn a batch file directly (EINVAL — CreateProcess cannot launch
// one), so `spawn('tsx.cmd', …)` and `spawn('tsx', …)` both fail there. Running
// the CLI file with `process.execPath` keeps one code path for every platform,
// needs no quoting, and is what the shim itself does.
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const cliArgs = process.argv.slice(2);
if (cliArgs[0] === '--') cliArgs.shift();
const child = spawn(
  process.execPath,
  [tsxCli, '--import', '../../build/register-raw-text-loader.mjs', './src/main.ts', ...cliArgs],
  {
    cwd: APP_ROOT,
    env,
    stdio: 'inherit',
  },
);

child.on('error', async (error) => {
  console.error(`Failed to start Scream Code dev CLI: ${error.message}`);
  await marketplaceServer?.close();
  process.exit(1);
});

child.on('exit', async (code, signal) => {
  await marketplaceServer?.close();
  if (signal !== null) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});
