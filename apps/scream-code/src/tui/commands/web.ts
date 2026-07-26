import { t } from '@scream-code/config';

import type { SlashCommandHost } from './dispatch';
import { startWebServerForSession, type WebServerHandle } from '#/web/server';

let activeHandle: WebServerHandle | null = null;

export async function handleWebCommand(host: SlashCommandHost, _args: string): Promise<void> {
  if (activeHandle) {
    host.showStatus(t('dispatch.web_already_running', { url: activeHandle.url }));
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(t('dispatch.web_no_session'));
    return;
  }

  const port = 3210;
  const homeDir = host.harness.homeDir;
  const workDir = session.workDir;

  let yolo = false;
  try {
    const status = await session.getStatus();
    yolo = status.permission === 'yolo';
  } catch {
    // Default to false.
  }

  try {
    activeHandle = await startWebServerForSession(session, {
      port,
      workDir,
      homeDir,
      yolo,
      open: true,
    });
    host.showNotice(
      t('dispatch.web_started_title'),
      t('dispatch.web_started_desc', { url: activeHandle.url }),
    );
  } catch (error) {
    host.showError(t('dispatch.web_start_failed', { error: String(error) }));
    activeHandle = null;
  }
}
