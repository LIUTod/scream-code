import { spawn } from 'node:child_process';

import { startBotServer } from '#/bot/server/index';
import type { BotServerOptions } from '#/bot/shared/contracts';

export interface BotOptions {
  port: number;
  model?: string;
  yolo: boolean;
  auto: boolean;
  open: boolean;
  lan: boolean;
  token?: string;
  idleMinutes: number;
  skillsDirs: string[];
}

/** Start the local Scream Bot gateway, open the browser, and wait for signals. */
export async function runBot(opts: BotOptions): Promise<void> {
  const options: BotServerOptions = {
    port: opts.port,
    host: opts.lan ? '0.0.0.0' : '127.0.0.1',
    model: opts.model,
    permission: opts.yolo || opts.auto ? 'auto' : 'bot',
    skillsDirs: opts.skillsDirs,
    lan: opts.lan,
    token: opts.token,
    idleMinutes: opts.idleMinutes,
  };

  const server = await startBotServer(options);
  process.stdout.write(`Scream Bot: ${server.url}\n`);
  if (opts.open) openBrowser(server.url);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void server.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args =
    process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Opening the browser is best-effort; the URL is already printed.
  }
}
