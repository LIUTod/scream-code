/**
 * Write plain text to the system clipboard with platform-specific commands.
 *
 * scream-core's clipboard layer is read-only (clipboard-native / clipboard-image),
 * so the TUI's "copy selected text" needs its own writer. Used to back the
 * pi-tui `copySelection` hook — return true/false so the TUI can flash
 * "Copied!" or "Copy failed".
 *
 * Platform mapping:
 *   macOS  -> pbcopy
 *   Windows-> powershell Set-Clipboard (base64 payload, avoids quoting issues)
 *   Linux  -> wl-copy (Wayland) / xclip -selection clipboard -i (X11)
 */

import { spawnSync } from 'node:child_process';

export class ClipboardTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClipboardTextError';
  }
}

export type RunCommand = (
  command: string,
  args: string[],
  input: string,
) => { ok: boolean; error?: string };

const defaultRunCommand: RunCommand = (command, args, input) => {
  const result = spawnSync(command, args, {
    input,
    encoding: 'utf8',
    timeout: 3000,
  });
  if (result.status === 0) return { ok: true };
  return { ok: false, error: result.error?.message ?? result.stderr?.toString() ?? `exit ${result.status}` };
};

function detectPlatform() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') {
    return process.env['WAYLAND_DISPLAY'] ? 'linux-wayland' : 'linux-x11';
  }
  return 'unsupported';
}

/**
 * Write `text` to the system clipboard. Throws ClipboardTextError when the
 * platform is unsupported or the underlying command fails, so callers can
 * surface a "Copy failed" indicator.
 */
export async function writeTextClipboard(
  text: string,
  runCommand: RunCommand = defaultRunCommand,
): Promise<void> {
  const platform = detectPlatform();
  let command: string;
  let args: string[];
  let input: string;

  switch (platform) {
    case 'macos':
      command = 'pbcopy';
      args = [];
      input = text;
      break;
    case 'windows': {
      // Base64 keeps the payload immune to PowerShell quoting/encoding issues.
      const base64 = Buffer.from(text, 'utf8').toString('base64');
      command = 'powershell';
      args = [
        '-NoProfile',
        '-Command',
        `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64}')) | Set-Clipboard`,
      ];
      input = '';
      break;
    }
    case 'linux-wayland':
      command = 'wl-copy';
      args = [];
      input = text;
      break;
    case 'linux-x11':
      command = 'xclip';
      args = ['-selection', 'clipboard', '-i'];
      input = text;
      break;
    default:
      throw new ClipboardTextError(`unsupported clipboard platform: ${process.platform}`);
  }

  const result = runCommand(command, args, input);
  if (!result.ok) {
    throw new ClipboardTextError(
      `failed to copy to clipboard: ${command} ${result.error ?? 'unknown error'}`,
    );
  }
}
