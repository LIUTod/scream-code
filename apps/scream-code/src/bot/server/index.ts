/**
 * `scream bot` server entry point.
 *
 * Owns the process-level wiring: SQLite store, one harness, runtime, Hono app
 * and the HTTP listener. The CLI only calls `startBotServer` and prints the
 * returned URL; tests drive the app directly through `createGateway`.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { serve } from '@hono/node-server';
import { ScreamHarness, resolveScreamHome } from '@scream-code/scream-code-sdk';

import type { BotServerHandle, BotServerOptions } from '../shared/contracts';
import { createGateway } from './gateway';
import { BotRuntime, createHarnessSessionFactory } from './runtime';
import { SseHub } from './sse';
import { BotStore } from './store';

export type { BotServerHandle, BotServerOptions } from '../shared/contracts';

const DEFAULT_BOT_NAME = 'Scream';

/**
 * Candidate `dist/bot-ui` locations across bundled, installed and source layouts.
 * All segments go through `node:path`, so the same list works on Windows.
 */
export function uiDirCandidates(
  moduleDir: string,
  cwd: string,
  joinPath: (...segments: string[]) => string = join,
): readonly string[] {
  return [
    // Bundled/installed CLI: the entrypoint lives in `<package>/dist`.
    joinPath(moduleDir, 'bot-ui'),
    joinPath(moduleDir, '../dist/bot-ui'),
    joinPath(cwd, 'dist', 'bot-ui'),
    joinPath(moduleDir, '../../../../dist/bot-ui'),
    joinPath(moduleDir, '../../../dist/bot-ui'),
    joinPath(moduleDir, '../../dist/bot-ui'),
  ];
}

/** First candidate that actually contains a built index page. */
export function pickUiDir(candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html')));
}

function resolveUiDir(): string | undefined {
  const found = pickUiDir(uiDirCandidates(import.meta.dirname, process.cwd()));
  if (found !== undefined) warnIfStaleBuild(found);
  return found;
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(path));
    else newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

/**
 * Serving a bundle older than its source looks exactly like "my change did
 * nothing", so say it out loud when running from a checkout.
 */
function warnIfStaleBuild(uiDir: string): void {
  try {
    const sourceDir = join(import.meta.dirname, '..', 'ui');
    if (!existsSync(sourceDir)) return;
    const built = statSync(join(uiDir, 'index.html')).mtimeMs;
    if (newestMtime(sourceDir) > built) {
      process.stderr.write(
        '[bot] The UI bundle is older than src/bot/ui. Run: pnpm --filter scream-code bot:build\n',
      );
    }
  } catch {
    // A read-only or partial checkout must not block startup.
  }
}

/** Gateway DB lives inside the Scream home so it survives reinstalls. */
export function resolveBotDatabasePath(homeDir: string | undefined): string {
  return join(resolveScreamHome(homeDir), 'bot', 'bot.db');
}

function displayHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '') return 'localhost';
  return host;
}

export async function startBotServer(options: BotServerOptions): Promise<BotServerHandle> {
  const homeDir = resolveScreamHome(options.homeDir);
  const store = new BotStore(resolveBotDatabasePath(homeDir));
  store.open();
  try {
    const firstRun = store.countBots() === 0;
    if (firstRun) {
      const bot = store.createBot({
        name: DEFAULT_BOT_NAME,
        title: '团队主 bot',
        workspace: process.cwd(),
        ...(options.permission === undefined ? {} : { permission: options.permission }),
      });
      store.appendAudit({
        actor: 'system',
        initiator: 'system',
        action: 'bot.created',
        decision: 'allowed',
        botId: bot.id,
        payload: { seeded: true },
      });
      store.createThread(bot.id);
    }

    const hub = new SseHub();
    // The harness needs the runtime's tool callback, and the runtime needs the
    // harness to open sessions, so the callback reads the runtime through a
    // holder that is filled in right after construction.
    const toolHost: { runtime?: BotRuntime } = {};
    const harness = new ScreamHarness({
      homeDir,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      uiMode: 'bot',
      ...(options.skillsDirs === undefined ? {} : { skillDirs: options.skillsDirs }),
      onToolCall: (request) =>
        toolHost.runtime === undefined
          ? Promise.resolve({ output: 'The Bot gateway is still starting up.', isError: true })
          : toolHost.runtime.handleToolCall(request),
    });

    const runtime = new BotRuntime({
      store,
      hub,
      sessions: createHarnessSessionFactory(harness, {
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.permission === undefined ? {} : { permission: options.permission }),
      }),
      ...(options.idleMinutes === undefined ? {} : { idleMinutes: options.idleMinutes }),
    });
    toolHost.runtime = runtime;
    runtime.start();

    const lan = options.lan === true;
    let token = options.token;
    if (lan && (token === undefined || token.length === 0)) {
      token = randomBytes(18).toString('base64url');
    }
    const uiDir = resolveUiDir();
    const app = createGateway({
      store,
      runtime,
      hub,
      auth: { lan, token },
      ...(uiDir === undefined ? {} : { uiDir }),
    });

    const host = options.host ?? (lan ? '0.0.0.0' : '127.0.0.1');
    const server = serve({ fetch: app.fetch, port: options.port, hostname: host });
    await new Promise<void>((resolveReady, reject) => {
      server.once('listening', () => {
        resolveReady();
      });
      server.once('error', (error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

    const address = server.address();
    const port =
      address !== null && typeof address === 'object' && 'port' in address
        ? address.port
        : options.port;
    const query = lan && token !== undefined ? `?token=${encodeURIComponent(token)}` : '';
    const url = `http://${displayHost(host)}:${String(port)}${query}`;

    let closing: Promise<void> | undefined;
    return {
      url,
      close: () => {
        closing ??= (async () => {
          await runtime.close();
          hub.close();
          (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
          await new Promise<void>((resolveClosed) => {
            server.close(() => {
              resolveClosed();
            });
          });
          await harness.close();
          store.close();
        })();
        return closing;
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

export { BotStore } from './store';
export { SseHub } from './sse';
export { BotRuntime } from './runtime';
export { createGateway } from './gateway';
export { BotFiles } from './files';
export { createAuthGuard } from './auth';
