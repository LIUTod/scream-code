/**
 * A system notification on the computer, for when something needs the
 * person and they may not be looking at a terminal (with or without a chat
 * channel): `notify-send` on a Linux desktop, a toast on Windows 10 and later
 * through PowerShell, and on macOS `terminal-notifier` when it is installed.
 *
 * Never `osascript` on macOS: a notification it posts belongs to Script
 * Editor — its name and icon on the banner, and a click opens Script Editor
 * on a new document. Without `terminal-notifier` the background shows
 * nothing itself and an open Scream terminal raises the heads-up through the
 * terminal instead (OSC 9 or the bell), so it comes from the terminal app and
 * a click brings that window forward. The same terminal fallback covers SSH
 * and a Linux without a desktop (see `hostShowsDesktopNotifications`).
 *
 * Best-effort and silent on failure: a server without a desktop, a Linux
 * without `notify-send`, a Windows that refuses the toast all just show
 * nothing. Off with the `/service` switch (`desktopNotifications`).
 */

import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

import { readHostSettings } from './settings';

function clean(text: string, max: number): string {
  const line = text.replaceAll(/[\r\n]+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

const onPath = new Map<string, string>();

/**
 * An executable on PATH, or null. Only a hit is remembered: a notifier
 * installed while the background runs is picked up by the next notification
 * (a miss costs a few file checks, and notifications are rare).
 */
function findOnPath(name: string): string | null {
  const known = onPath.get(name);
  if (known !== undefined) return known;
  let found: string | null = null;
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      found = candidate;
      break;
    } catch {
      // Not here.
    }
  }
  if (found !== null) onPath.set(name, found);
  return found;
}

function findTerminalNotifier(): string | null {
  return findOnPath('terminal-notifier');
}

/**
 * Whether the background's system notification reaches the person at this
 * terminal, judged from the terminal's side. False — so the terminal raises
 * it itself (OSC 9 or the bell) — on a Mac without terminal-notifier, over
 * SSH (the toast would show on the remote computer's screen, if anywhere),
 * and on a Linux without a graphical session or `notify-send`.
 */
export function hostShowsDesktopNotifications(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  has: (name: string) => boolean = (name) => findOnPath(name) !== null,
): boolean {
  if ((env['SSH_CONNECTION'] ?? env['SSH_TTY'] ?? '') !== '') return false;
  if (platform === 'darwin') return has('terminal-notifier');
  if (platform === 'linux') {
    const graphical = (env['DISPLAY'] ?? '') !== '' || (env['WAYLAND_DISPLAY'] ?? '') !== '';
    return graphical && has('notify-send');
  }
  return platform === 'win32';
}

/** The command that shows one notification, per platform (exported for tests). */
export function desktopNotifyCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
  macNotifier: string | null = platform === 'darwin' ? findTerminalNotifier() : null,
): { command: string; args: string[] } | undefined {
  const t = clean(title, 80);
  const b = clean(body, 200);
  if (platform === 'darwin') {
    // Arguments, not a script: nothing to escape. A message starting with
    // "-" or "[" would be read as an option, so it gets a leading space.
    const arg = (value: string): string => (/^[-[]/.test(value) ? ` ${value}` : value);
    return macNotifier === null
      ? undefined
      : { command: macNotifier, args: ['-title', arg(t), '-message', arg(b === '' ? t : b), '-group', 'scream'] };
  }
  // `--` ends the options, so a title or message starting with "-" is not read as one.
  if (platform === 'linux') return { command: 'notify-send', args: ['--app-name=Scream', '--', t, b] };
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
