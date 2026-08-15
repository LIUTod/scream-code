import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SlashCommandHost } from './dispatch';
import { buildTraceCells } from '#/utils/trace/trace-builder';
import { renderTraceHtml } from '#/utils/trace/render-trace-html';

/**
 * `/trace` — snapshot the current session's trajectory as a self-contained
 * interactive HTML document and open it in the browser. The file is written
 * to the OS temp dir (never the desktop / project), so repeated invocations
 * do not accumulate artifacts.
 */
export function handleTraceCommand(host: SlashCommandHost): void {
  void runTrace(host);
}

async function runTrace(host: SlashCommandHost): Promise<void> {
  try {
    const session = host.session;
    const sessionDir = session?.summary?.sessionDir;
    if (!sessionDir) {
      host.showError('当前会话不可用，无法导出轨迹');
      return;
    }
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    if (!existsSync(wirePath)) {
      host.showError(`未找到轨迹文件: ${wirePath}`);
      return;
    }

    const cells = buildTraceCells({ wirePath });
    const title = session?.summary?.title ?? host.state.appState.sessionTitle ?? 'session';
    const html = renderTraceHtml({
      title,
      sessionId: session?.id ?? 'unknown',
      createdAt: Date.now(),
      cells,
    });

    // Fixed name so every invocation replaces the previous trace (no
    // accumulating artifacts). Open via a cache-busting file URL so the
    // browser never serves the stale copy.
    const filePath = join(tmpdir(), 'scream-trace.html');
    writeFileSync(filePath, html, 'utf8');

    const opened = await openInBrowser(filePath);
    host.showStatus(opened ? '轨迹已打开' : '轨迹已生成，请手动打开');
  } catch (error) {
    host.showError(`轨迹导出失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function openInBrowser(filePath: string): Promise<boolean> {
  // ?v=<ts> busts the browser cache while keeping the filename stable.
  const url = `file://${filePath}?v=${Date.now()}`;
  let command: string;
  let args: string[];
  if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    // `start` is a cmd.exe builtin, not an executable — spawn via cmd /c.
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => resolve(false));
    child.on('spawn', () => resolve(true));
  });
}
