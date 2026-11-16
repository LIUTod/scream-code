/**
 * `scream line [run|start|stop|status]` — CLI control surface for the line
 * daemon. The daemon itself is `runLineDaemon()`; start/stop/status operate
 * on the pidfile (`src/line/pidfile.ts`). The `/line` TUI command calls the
 * same functions directly (no subprocess), this module exists for scripted
 * and terminal use.
 */

import { LineConfigError, getLineConfigPath, loadLineConfig } from '#/line/config';
import { t } from '@scream-code/config';
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
        out(t('cli.line.not_configured'));
        return;
      }
      const { pid, alreadyRunning } = await startLineDaemonDetached();
      out(
        alreadyRunning
          ? t('cli.line.already_running', { pid: String(pid) })
          : t('cli.line.started', { pid: String(pid) }),
      );
      return;
    }
    case 'stop': {
      const stopped = await stopLineDaemon();
      out(stopped ? t('cli.line.stopped') : t('cli.line.not_running'));
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
      const state = status.running
        ? t('cli.line.state_running', { pid: String(status.pid) })
        : t('cli.line.state_stopped');
      out(t('cli.line.status', { state }));
      const configured = (on: unknown): string =>
        on ? t('cli.line.configured') : t('cli.line.unconfigured');
      out(t('cli.line.platforms', { feishu: configured(feishu), weixin: configured(weixin) }));
      out(t('cli.line.config_file', { path: getLineConfigPath() }));
      if (feishu || weixin) {
        out(
          t('cli.line.mode', {
            mode: permissionMode,
            auto: autoStart ? t('cli.line.on') : t('cli.line.off'),
          }),
        );
      } else {
        out(t('cli.line.setup_hint'));
      }
      return;
    }
  }
}
