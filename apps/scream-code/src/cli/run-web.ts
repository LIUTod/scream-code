/**
 * `scream web` CLI entry point.
 *
 * Starts a local HTTP + WebSocket server that serves a browser-based chat UI
 * connected to the ScreamCode agent. This is a third consumer of agent-core
 * (alongside run-shell TUI and run-stream-json), not a separate engine.
 */

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

import { resolveScreamHome } from '@scream-code/scream-code-sdk';

import { GatewayAuth } from '#/web/auth';
import { runWebServer } from '#/web/server';

export interface WebOptions {
  readonly port: number;
  readonly model?: string;
  readonly yolo: boolean;
  readonly auto: boolean;
  readonly open: boolean;
  readonly skillsDirs: string[];
  /** LAN mode: bind 0.0.0.0 and require gateway auth for non-local devices. */
  readonly lan: boolean;
  /** Custom gateway access key (persisted, replacing any stored key). */
  readonly token?: string;
  /** Interactively replace the stored gateway access key. */
  readonly resetPassword: boolean;
}

function promptSecret(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    // A muted output stream suppresses terminal echo of the typed key.
    const muted = new Writable({
      write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        callback();
      },
    });
    const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stderr.write(question);
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer.trim());
    });
  });
}

export async function runWeb(opts: WebOptions): Promise<void> {
  let token = opts.token;
  if (opts.resetPassword) {
    const key = await promptSecret('输入新的网关访问密钥（输入不会回显）：');
    if (key === null) {
      throw new Error('重设访问密钥需要交互终端。');
    }
    if (key.length === 0) {
      throw new Error('访问密钥不能为空。');
    }
    const confirmed = await promptSecret('确认新的网关访问密钥：');
    if (confirmed !== key) {
      throw new Error('两次输入的密钥不一致。');
    }
    token = key;
  }

  // Persist an explicit key even without --lan, so a later `--lan` start
  // picks it up instead of generating a fresh one.
  if (!opts.lan && token !== undefined) {
    await GatewayAuth.setup({ homeDir: resolveScreamHome(), token });
  }

  await runWebServer({
    port: opts.port,
    workDir: process.cwd(),
    model: opts.model,
    yolo: opts.yolo,
    auto: opts.auto,
    open: opts.open,
    skillsDirs: opts.skillsDirs,
    lan: opts.lan,
    token,
  });
}
