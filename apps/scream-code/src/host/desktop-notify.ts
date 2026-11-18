/**
 * A system notification on the computer, for when something needs the
 * person and they may not be looking at a terminal (with or without a chat
 * channel): macOS Notification Center through `osascript`, `notify-send`
 * on a Linux desktop, a toast on Windows 10 and later through PowerShell.
 *
 * Best-effort and silent on failure: a server without a desktop, a Linux
 * without `notify-send`, a Windows that refuses the toast all just show
 * nothing. Off with the `/service` switch (`desktopNotifications`).
 */

import { spawn } from 'node:child_process';

import { readHostSettings } from './settings';

function clean(text: string, max: number): string {
  const line = text.replaceAll(/[\r\n]+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** The command that shows one notification, per platform (exported for tests). */
export function desktopNotifyCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
): { command: string; args: string[] } | undefined {
  const t = clean(title, 80);
  const b = clean(body, 200);
  if (platform === 'darwin') {
    // AppleScript strings: escape backslashes and quotes.
    const q = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    return { command: 'osascript', args: ['-e', `display notification ${q(b)} with title ${q(t)}`] };
  }
  if (platform === 'linux') return { command: 'notify-send', args: ['--app-name=Scream', t, b] };
  if (platform === 'win32') {
    // Passed through environment variables, never spliced into the script.
    const script = [
      '$x=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]',
      '$doc=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '$n=$doc.GetElementsByTagName("text")',
      '[void]$n.Item(0).AppendChild($doc.CreateTextNode($env:SCREAM_NOTIFY_TITLE))',
      '[void]$n.Item(1).AppendChild($doc.CreateTextNode($env:SCREAM_NOTIFY_BODY))',
      '$app="{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($doc))',
    ].join('; ');
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    };
  }
  return undefined;
}

export function notifyDesktop(title: string, body: string): void {
  if (!readHostSettings().desktopNotifications) return;
  const command = desktopNotifyCommand(process.platform, title, body);
  if (command === undefined) return;
  try {
    const child = spawn(command.command, command.args, {
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
      env: { ...process.env, SCREAM_NOTIFY_TITLE: clean(title, 80), SCREAM_NOTIFY_BODY: clean(body, 200) },
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No notifier on this system: nothing to show.
  }
}
