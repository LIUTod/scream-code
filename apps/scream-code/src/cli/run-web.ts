/**
 * `scream web` CLI entry point.
 *
 * Starts a local HTTP + WebSocket server that serves a browser-based chat UI
 * connected to the ScreamCode agent. This is a third consumer of agent-core
 * (alongside run-shell TUI and run-stream-json), not a separate engine.
 */

import { runWebServer } from '#/web/server';

export interface WebOptions {
  readonly port: number;
  readonly model?: string;
  readonly yolo: boolean;
  readonly auto: boolean;
  readonly open: boolean;
  readonly skillsDirs: string[];
}

export async function runWeb(opts: WebOptions): Promise<void> {
  await runWebServer({
    port: opts.port,
    workDir: process.cwd(),
    model: opts.model,
    yolo: opts.yolo,
    auto: opts.auto,
    open: opts.open,
    skillsDirs: opts.skillsDirs,
  });
}
