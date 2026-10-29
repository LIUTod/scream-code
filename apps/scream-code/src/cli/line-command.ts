/**
 * `scream line [run|start|stop|status]` — CLI control surface for the line
 * daemon. The daemon itself is `runLineDaemon()`; start/stop/status operate
 * on the pidfile (`src/line/pidfile.ts`). The `/line` TUI command calls the
 * same functions directly (no subprocess), this module exists for scripted
 * and terminal use.
 */

import { LineConfigError, getLineConfigPath, loadLineConfig } from '#/line/config';
import { runLineDaemon } from '#/line/daemon';
import { readLineDaemonStatus, startLineDaemonDetached, stopLineDaemon } from '#/line/pidfile';

export type LineAction = 'run' | 'start' | 'stop' | 'status';

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

export async function runLineCommand(action: LineAction): Promise<void> {
  switch (action) {
    case 'run':
      await runLineDaemon();
      return;
    case 'start': {
      const config = await loadLineConfig();
      if (!config?.feishu && !config?.weixin) {
        out('尚未配置任何平台（飞书/微信）。请在 scream TUI 里运行 /line 完成配置向导。');
        return;
      }
      const { pid, alreadyRunning } = await startLineDaemonDetached();
      out(
        alreadyRunning
          ? `line 守护进程已在运行（pid ${pid}）。`
          : `line 守护进程已启动（pid ${pid}）。日志：~/.scream-code/line/daemon.log`,
      );
      return;
    }
    case 'stop': {
      const stopped = await stopLineDaemon();
      out(stopped ? 'line 守护进程已停止。' : 'line 守护进程未在运行。');
      return;
    }
    case 'status': {
      let feishu = false;
      let weixin = false;
      let permissionMode = '';
      let autoStart = false;
      try {
        const config = await loadLineConfig();
        feishu = config?.feishu !== undefined;
        weixin = config?.weixin !== undefined;
        permissionMode = config?.permissionMode ?? '';
        autoStart = config?.autoStart ?? false;
      } catch (error) {
        if (error instanceof LineConfigError) {
          process.stderr.write(`${error.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
      const status = await readLineDaemonStatus();
      const state = status.running ? `运行中（pid ${status.pid}）` : '未运行';
      out(`line 守护进程：${state}`);
      out(`飞书配置：${feishu ? '已配置' : '未配置'}；微信配置：${weixin ? '已配置' : '未配置'}`);
      out(`配置文件：${getLineConfigPath()}`);
      if (feishu || weixin) {
        out(`权限模式：${permissionMode}；开机随 scream 自动拉起：${autoStart ? '开' : '关'}`);
      } else {
        out('提示：在 scream TUI 里运行 /line 完成配置向导（飞书或微信）。');
      }
      return;
    }
  }
}
