/**
 * TUI-boot auto-start for the line daemon.
 *
 * When a line config exists with `autoStart: true` and the daemon is not
 * running, spawn it detached so the Feishu channel comes up together with
 * the TUI (and survives the TUI exiting — the daemon is its own process).
 * Failures are non-fatal: the TUI keeps booting and the footer dot shows
 * the daemon as off.
 */

import { log } from '@scream-code/scream-code-sdk';

import { LineConfigError, loadLineConfig } from './config';
import { readLineDaemonStatus, startLineDaemonDetached } from './pidfile';

export async function autoStartLineDaemonIfConfigured(): Promise<void> {
  try {
    const config = await loadLineConfig();
    if (!config?.feishu && !config?.weixin) return;
    if (!config.autoStart) return;
    const status = await readLineDaemonStatus();
    if (status.running) return;
    const { pid } = await startLineDaemonDetached();
    log.info('line: auto-started daemon on TUI boot', { pid });
  } catch (error) {
    if (error instanceof LineConfigError) {
      log.warn('line: auto-start skipped, config invalid', { error: error.message });
      return;
    }
    log.warn('line: auto-start failed (non-fatal)', { error: String(error) });
  }
}
