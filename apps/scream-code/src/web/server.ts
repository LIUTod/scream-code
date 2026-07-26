/**
 * Scream Web UI server.
 *
 * Embeds a ScreamHarness instance and exposes it over HTTP + WebSocket.
 * The HTTP server serves a single-page chat UI; the WebSocket server
 * provides bidirectional communication (events out, prompts/approvals in).
 *
 * Architecture: agent-core is fully UI-agnostic. This module is a third
 * consumer of the same SDK (alongside run-shell TUI and run-stream-json),
 * not a separate engine. Zero changes to agent-core or node-sdk.
 */

import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';

import {
  ScreamHarness,
  resolveScreamHome,
  log,
  type Session,
} from '@scream-code/scream-code-sdk';
import { setLocale } from '@scream-code/config';

import { loadTuiConfig, TuiConfigParseError } from '#/tui/config';
import { createScreamCodeHostIdentity } from '#/cli/version';

// ─── Types ────────────────────────────────────────────────────────────────

export interface WebServerOptions {
  readonly port: number;
  readonly workDir: string;
  readonly model?: string;
  readonly yolo: boolean;
  readonly auto: boolean;
  readonly open: boolean;
  readonly skillsDirs: string[];
}

// ─── Server ───────────────────────────────────────────────────────────────

export async function runWebServer(opts: WebServerOptions): Promise<void> {
  const homeDir = resolveScreamHome();
  const workDir = opts.workDir;

  const harness = new ScreamHarness({
    homeDir,
    identity: createScreamCodeHostIdentity('dev'),
    uiMode: 'print',
    skillDirs: opts.skillsDirs,
  });

  // Load tui config for locale + subagent model bindings (same as stream-json).
  try {
    const tuiConfig = await loadTuiConfig();
    setLocale(tuiConfig.language);
    harness.setSubagentModelBindings(() => tuiConfig.subagentModels);
  } catch (error) {
    if (error instanceof TuiConfigParseError) {
      setLocale(error.fallback.language);
    } else {
      throw error;
    }
  }

  await harness.ensureConfigFile();
  const config = await harness.getConfig();

  const session = await harness.createSession({
    workDir,
    model: opts.model ?? config.defaultModel,
    permission: opts.yolo ? 'yolo' : opts.auto ? 'auto' : 'manual',
  });

  log.info('web: session created', { sessionId: session.id, workDir });

  // MVP: single active WebSocket connection.
  let activeWs: WebSocket | null = null;
  let unsubscribe: (() => void) | null = null;

  // Pending approvals awaiting browser response.
  const pendingApprovals = new Map<
    string,
    (response: {
      decision: 'approved' | 'rejected';
      scope?: 'session';
      feedback?: string;
    }) => void
  >();

  // ── Approval handler (wired once on session creation) ──────────────────
  session.setApprovalHandler((request) => {
    if (opts.yolo) return { decision: 'approved' };
    const ws = activeWs;
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      return { decision: 'rejected', feedback: 'No browser connected' };
    }
    return new Promise((resolve) => {
      const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      pendingApprovals.set(id, resolve);
      ws.send(
        JSON.stringify({
          type: 'approval_request',
          id,
          toolName: request.toolName,
          action: request.action,
          display: request.display,
        }),
      );
    });
  });
  session.setQuestionHandler(() => null);

  // ── HTTP server: serve the chat page ───────────────────────────────────
  const __dirname = import.meta.dirname;
  const httpServer: HttpServer = createServer(
    async (req: IncomingMessage, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        try {
          const htmlPath = join(__dirname, 'public', 'index.html');
          const html = await readFile(htmlPath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Failed to load web UI');
        }
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    },
  );

  // ── WebSocket server ───────────────────────────────────────────────────
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket) => {
    if (activeWs !== null && activeWs.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'Another browser is already connected',
        }),
      );
      ws.close(1008, 'Only one connection allowed');
      return;
    }
    // If a previous connection is already closing/closed, clear the slot.
    if (activeWs !== null && activeWs.readyState !== WebSocket.OPEN) {
      activeWs = null;
    }

    activeWs = ws;
    log.info('web: client connected');

    // Send session init so the browser knows the session ID.
    ws.send(
      JSON.stringify({
        type: 'session_init',
        sessionId: session.id,
        workDir,
      }),
    );

    // Subscribe to agent events and forward to browser.
    unsubscribe = session.onEvent((event) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'event', event }));
      }
    });

    // Receive messages from browser.
    ws.on('message', (data: Buffer) => {
      let msg: { type: string; [key: string]: unknown };
      try {
        msg = JSON.parse(data.toString()) as { type: string; [key: string]: unknown };
      } catch {
        return;
      }

      if (msg.type === 'prompt') {
        const text = msg['text'] as string;
        if (!text) return;
        void session.prompt(text).catch((error: unknown) => {
          const errMsg = error instanceof Error ? error.message : String(error);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: errMsg }));
          }
        });
      } else if (msg.type === 'approval_response') {
        const id = msg['id'] as string;
        const decision = msg['decision'] as 'approved' | 'rejected';
        const handler = pendingApprovals.get(id);
        if (handler) {
          pendingApprovals.delete(id);
          handler({
            decision,
            scope: decision === 'approved' ? 'session' : undefined,
          });
        }
      }
    });

    ws.on('close', () => {
      log.info('web: client disconnected');
      unsubscribe?.();
      unsubscribe = null;
      activeWs = null;
      // Reject pending approvals so the agent doesn't hang.
      for (const [, resolve] of pendingApprovals) {
        resolve({ decision: 'rejected', feedback: 'Browser disconnected' });
      }
      pendingApprovals.clear();
    });
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    for (const [, resolve] of pendingApprovals) {
      resolve({ decision: 'rejected', feedback: 'Server shutting down' });
    }
    pendingApprovals.clear();
    try {
      wss.close();
      await session.close({ extractMemories: false });
      await harness.close();
    } catch {
      // Best-effort
    }
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  process.on('SIGINT', () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void cleanup().finally(() => process.exit(0));
  });

  // ── Start ──────────────────────────────────────────────────────────────
  httpServer.listen(opts.port, () => {
    const url = `http://localhost:${opts.port}`;
    // eslint-disable-next-line no-console
    console.log(
      `\n  Scream Web UI ready: ${url}\n` +
        `  Working directory: ${workDir}\n` +
        `  Session: ${session.id}\n` +
        `  Permission: ${opts.yolo ? 'yolo' : opts.auto ? 'auto' : 'manual'}\n`,
    );
    if (opts.open) {
      const openCmd =
        process.platform === 'darwin' ? 'open' :
        process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${openCmd} ${url}`);
    }
  });
}
