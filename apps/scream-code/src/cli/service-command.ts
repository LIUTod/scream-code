/**
 * `scream service [install|uninstall|status|restart|logs]` — the resident
 * service from a shell (a server without the TUI, a script). `/service` in the
 * TUI does the same through a panel.
 */

import { readFile } from 'node:fs/promises';

import { t } from '@scream-code/config';

import { getHostLogFile } from '#/host/control';
import {
  installService,
  restartService,
  serviceManagerFor,
  uninstallService,
  type ServiceResult,
} from '#/host/service';
import { describeServiceStart, readServiceSummary, serviceSummaryLines } from '#/host/service-summary';

export type ServiceAction = 'install' | 'uninstall' | 'status' | 'restart' | 'logs';

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(result: ServiceResult): void {
  process.stderr.write(`${t('service.failed', { error: result.error ?? '' })}\n`);
  process.exitCode = 1;
}

export async function runServiceCommand(action: ServiceAction): Promise<void> {
  if (serviceManagerFor() === undefined && action !== 'logs') {
    process.stderr.write(`${t('service.unsupported', { platform: process.platform })}\n`);
    process.exitCode = 1;
    return;
  }
  switch (action) {
    case 'install': {
      out(t('service.enabling'));
      const result = await installService();
      if (!result.ok) {
        fail(result);
        return;
      }
      const summary = await readServiceSummary();
      out(t('service.enabled', { when: describeServiceStart(summary.status) }));
      for (const line of serviceSummaryLines(summary).slice(1)) out(line);
      return;
    }
    case 'uninstall': {
      const result = await uninstallService();
      if (!result.ok) {
        fail(result);
        return;
      }
      out(t('service.disabled'));
      return;
    }
    case 'restart': {
      const result = await restartService();
      if (!result.ok) {
        fail(result);
        return;
      }
      out(t('service.restarted'));
      return;
    }
    case 'logs': {
      const log = getHostLogFile();
      out(t('service.logs_path', { path: log }));
      const text = await readFile(log, 'utf8').catch(() => '');
      const tail = text.split('\n').filter((line) => line !== '').slice(-20);
      for (const line of tail) out(line);
      return;
    }
    case 'status': {
      for (const line of serviceSummaryLines(await readServiceSummary())) out(line);
      return;
    }
  }
}
