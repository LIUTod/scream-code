/**
 * Standalone gateway process: `pnpm --filter scream-code run bot:server`.
 *
 * The CLI calls `startBotServer` directly; this file exists so the server can
 * be exercised without the CLI (and so a packaged `scream bot` has one obvious
 * entry point).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { BotPermission, BotServerHandle, BotServerOptions } from '../shared/contracts';

/**
 * Source-mode runs (`tsx src/bot/server/main.ts`) must register the repo's
 * `.yaml`/`.md` raw-text loader before agent-core's prompt assets load — the
 * bundled build inlines them instead. Installed builds have no loader file, so
 * this is a no-op there.
 */
async function loadServer(): Promise<{
  startBotServer: (options: BotServerOptions) => Promise<BotServerHandle>;
}> {
  const loader = join(import.meta.dirname, '../../../../../build/register-raw-text-loader.mjs');
  if (existsSync(loader)) {
    register(pathToFileURL(loader).href);
  }
  const server = await import('./index');
  return { startBotServer: server.startBotServer };
}

interface ParsedArgs {
  readonly options: BotServerOptions;
  readonly open: boolean;
  readonly help: boolean;
  readonly error: string | undefined;
}

const USAGE: readonly string[] = [
  'Usage: scream bot [options]',
  '',
  '  --port, -p <port>      Port to listen on (default 3210)',
  '  --host <host>          Bind address (default 127.0.0.1)',
  '  --lan                  Bind all interfaces and require a token',
  '  --token <token>        Gateway token for LAN mode',
  '  --model <model>        Default model for bots without one',
  '  --permission <bot|auto> Default permission tier for bots without one',
  '  --idle-minutes <n>     Close idle sessions after n minutes',
  '  --home <dir>           Scream home directory',
  '  --config <path>        Config file path',
  '  --no-open              Do not open a browser',
  '',
];

const PERMISSION_TIERS: ReadonlySet<string> = new Set(['bot', 'auto']);

function parseArgs(argv: readonly string[]): ParsedArgs {
  let port = 3210;
  let host: string | undefined;
  let model: string | undefined;
  let permission: BotPermission | undefined;
  let lan = false;
  let token: string | undefined;
  let idleMinutes: number | undefined;
  let homeDir: string | undefined;
  let configPath: string | undefined;
  let open = true;
  let help = false;
  let error: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    const next = (): string | undefined => {
      const value = argv[index + 1];
      if (value !== undefined) index += 1;
      return value;
    };
    switch (arg) {
      case '--port':
      case '-p': {
        const value = Number(next());
        if (Number.isInteger(value) && value > 0 && value < 65_536) port = value;
        break;
      }
      case '--host':
        host = next();
        break;
      case '--model':
        model = next();
        break;
      case '--permission': {
        const value = next();
        // There is no third tier: reject outright instead of silently folding,
        // so a typo cannot quietly downgrade a Bot to the safe mode.
        if (value === undefined || !PERMISSION_TIERS.has(value)) {
          error = value === undefined
            ? 'Missing value for --permission (expected bot or auto)'
            : `Invalid value for --permission: '${value}' (expected bot or auto)`;
          break;
        }
        permission = value as BotPermission;
        break;
      }
      case '--lan':
        lan = true;
        break;
      case '--token':
        token = next();
        break;
      case '--idle-minutes':
        idleMinutes = Number(next());
        break;
      case '--home':
        homeDir = next();
        break;
      case '--config':
        configPath = next();
        break;
      case '--no-open':
        open = false;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        break;
    }
  }

  return {
    options: {
      port,
      ...(host === undefined ? {} : { host }),
      ...(model === undefined ? {} : { model }),
      ...(permission === undefined ? {} : { permission }),
      lan,
      ...(token === undefined ? {} : { token }),
      ...(idleMinutes === undefined || !Number.isFinite(idleMinutes) ? {} : { idleMinutes }),
      ...(homeDir === undefined ? {} : { homeDir }),
      ...(configPath === undefined ? {} : { configPath }),
    },
    open,
    help,
    error,
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error !== undefined) {
    process.stderr.write(`${parsed.error}\n\n${USAGE.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  if (parsed.help) {
    process.stdout.write(`${USAGE.join('\n')}\n`);
    return;
  }

  const { startBotServer } = await loadServer();
  const handle = await startBotServer(parsed.options);
  process.stdout.write(`Scream bot gateway: ${handle.url}\n`);

  if (parsed.open && process.platform === 'darwin') {
    try {
      const child = spawn('open', [handle.url], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch {
      // Opening a browser is best-effort.
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\nReceived ${signal}, shutting down…\n`);
    try {
      await handle.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}
