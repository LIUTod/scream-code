/**
 * Create a desktop shortcut for Scream Code on Windows.
 *
 * Only runs on Win32 and for global installs. Never fails the install —
 * errors are caught and swallowed.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

export function createDesktopShortcut() {
  if (process.platform !== 'win32') return;

  const iconPath = resolve(import.meta.dirname, '../../icon.ico');

  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        shortcutPowerShellScript.replace(
          '__ICON_LOCATION__',
          existsSync(iconPath) ? iconPath : '',
        ),
      ],
      { stdio: 'ignore', timeout: 10_000 },
    );
  } catch {
    // Never fail the install over a shortcut.
  }
}

const shortcutPowerShellScript = `
$ErrorActionPreference = 'Stop'

$DesktopPath = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = "$DesktopPath\\Scream Code.lnk"
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)

$wt    = Get-Command wt.exe           -ErrorAction SilentlyContinue
$pwsh7 = Get-Command pwsh.exe         -ErrorAction SilentlyContinue
$ps5   = Get-Command powershell.exe   -ErrorAction SilentlyContinue

if ($wt) {
    $Shortcut.TargetPath = $wt.Source
    $Shortcut.Arguments  = '--title "Scream Code" cmd /k "chcp 65001 > nul && scream"'
}
elseif ($pwsh7) {
    $Shortcut.TargetPath = $pwsh7.Source
    $Shortcut.Arguments  = '-NoExit -Command "chcp 65001 > $null; scream"'
}
elseif ($ps5) {
    $Shortcut.TargetPath = $ps5.Source
    $Shortcut.Arguments  = '-NoExit -Command "chcp 65001 > $null; [Console]::OutputEncoding = [Console]::InputEncoding = [Text.Encoding]::UTF8; $Host.UI.RawUI.WindowTitle = ''Scream Code''; scream"'
}
else {
    $Shortcut.TargetPath = 'powershell.exe'
    $Shortcut.Arguments  = '-NoExit -Command "chcp 65001 > $null; [Console]::OutputEncoding = [Console]::InputEncoding = [Text.Encoding]::UTF8; $Host.UI.RawUI.WindowTitle = ''Scream Code''; scream"'
}

$Shortcut.WorkingDirectory = $env:USERPROFILE
$Shortcut.Description      = 'Scream Code - AI 命令行助手'

$IconPath = '__ICON_LOCATION__'
if ($IconPath -and (Test-Path $IconPath)) {
    $Shortcut.IconLocation = $IconPath
}

$Shortcut.Save()
`.trim();
