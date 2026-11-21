/**
 * `scream host [run|start|stop|status]` and its older name `scream line` — CLI
 * control surface for the background host (`src/host/run.ts`), which also
 * serves the chat channel. start/stop/status go through its process lock
 * (`src/host/control.ts`). The `/line` TUI command calls the
 * same functions directly (no subprocess), this module exists for scripted
 * and terminal use.
 */

import { LineConfigError, getLineConfigPath, loadLineConfig } from '#/line/config';
import { t } from '@scream-code/config';
import { getVersion } from '#/cli/version';
import { runHost } from '#/host/run';
import { getHostLogFile, readHostStatus, startHostDetached, stopHost } from '#/host/control';
import { pauseAllBackgroundWork } from '#/host/pause-all';
import { readServiceStatus, restartService } from '#/host/service';
import { staleBuildLine } from '#/host/service-summary';

export type LineAction = 'run' | 'start' | 'stop' | 'status' | 'restart' | 'pause';

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * `surface` is the command it was typed as: `line` (start requires a
 * configured channel, as it always did) or `host` (the host runs without one,
 * continuing interrupted work).
 */
export async function runLineCommand(action: LineAction, surface: 'line' | 'host' = 'line'): Promise<void> {
  switch (action) {
    case 'run':
      await runHost();
      return;
    case 'start': {
      if (surface === 'line') {
        const config = await loadLineConfig();
        if (!config?.feishu && !config?.weixin) {
          out(t('cli.line.not_configured'));
          return;
        }
      }
      const { pid, alreadyRunning } = await startHostDetached();
      out(
        alreadyRunning
          ? t('cli.line.already_running', { pid: String(pid) })
          : t('cli.line.started', { pid: String(pid), log: getHostLogFile() }),
      );
      return;
    }
    case 'pause': {
      const result = await pauseAllBackgroundWork();
      out(t('jobs.paused_all', { count: String(result.paused) }));
      return;
    }
    case 'restart': {
      // A service-managed host is restarted by its service manager, so it
      // stays under it; otherwise stop the running host and start a new one.
      if ((await readServiceStatus()).installed) {
        const result = await restartService();
        out(result.ok ? t('service.restarted') : t('service.failed', { error: result.error ?? '' }));
        if (!result.ok) process.exitCode = 1;
        return;
      }
      await stopHost();
      const { pid } = await startHostDetached();
      out(t('cli.line.started', { pid: String(pid), log: getHostLogFile() }));
      return;
    }
    case 'stop': {
      const stopped = await stopHost({
        onWaiting: () => {
          out(t('cli.line.stopping'));
        },
      });
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
      const status = await readHostStatus();
      const state = status.running
        ? t('cli.line.state_running', { pid: String(status.pid) })
        : t('cli.line.state_stopped');
      out(t('cli.line.status', { state }));
      // An upgrade does not restart the host: it keeps executing the build it
      // loaded, and nothing used to say so — the person installs a new version,
      // sees the old behaviour, and reports the bug again.
      const drift = staleBuildLine(
        { running: status.running, ...(status.version === undefined ? {} : { version: status.version }) },
        getVersion(),
      );
      if (drift !== undefined) out(drift);
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
