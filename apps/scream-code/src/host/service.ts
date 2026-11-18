/**
 * Installing the background host as a per-user service, so it starts with
 * the person's login and is restarted after a crash: a LaunchAgent on macOS, a
 * systemd user unit on Linux, a logon task on Windows. None needs
 * administrator rights.
 *
 * The service runs a launcher script in the Scream home (`<home>/bin`) rather
 * than node directly: the script pins the node binary, scream's entry file,
 * the Scream home and the PATH of the shell `install` ran in. A service starts
 * with almost no environment (launchd and systemd give a minimal PATH, so git
 * or ripgrep would not be found), and node's path changes with every version
 * manager switch. Every scream start calls {@link refreshServiceLauncher},
 * which rewrites the script when any of that moved, so an upgrade or a new
 * node version never leaves a service pointing at a binary that is gone.
 *
 * One service per Scream home: its name carries a hash of the home's real
 * path, so a second home (`SCREAM_CODE_HOME`) gets a service of its own.
 *
 * What "starts automatically" means differs by platform, and the status says
 * so: macOS and Windows start it at login; Linux starts it at login, or at
 * boot without a login once lingering is enabled for the user
 * (`loginctl enable-linger`).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { getDataDir } from '#/utils/paths';

import { getHostLogFile, startHostDetached, stopHost } from './control';

const execFileAsync = promisify(execFile);

export type ServiceManager = 'launchd' | 'systemd' | 'schtasks';

export interface ServiceStatus {
  readonly manager: ServiceManager | undefined;
  readonly installed: boolean;
  /** Linux: whether the unit also starts at boot without a login (lingering). */
  readonly linger?: boolean | undefined;
}

export interface ServiceResult {
  readonly ok: boolean;
  /** What went wrong, in the service manager's own words. */
  readonly error?: string | undefined;
  /** Linux after install: lingering is off, so the unit waits for a login. */
  readonly lingerOff?: boolean | undefined;
}

interface ServicePaths {
  readonly manager: ServiceManager;
  readonly name: string;
  readonly launcher: string;
  /** The plist (macOS) or unit file (Linux); undefined on Windows. */
  readonly definition: string | undefined;
}

export function serviceManagerFor(platform: NodeJS.Platform = process.platform): ServiceManager | undefined {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  if (platform === 'win32') return 'schtasks';
  return undefined;
}

function homeKey(): string {
  let home = getDataDir();
  try {
    home = realpathSync.native(home);
  } catch {
    home = resolve(home);
  }
  return createHash('sha256').update(home).digest('hex').slice(0, 10);
}

function servicePaths(platform: NodeJS.Platform = process.platform): ServicePaths | undefined {
  const manager = serviceManagerFor(platform);
  if (manager === undefined) return undefined;
  const key = homeKey();
  const binDir = join(getDataDir(), 'bin');
  if (manager === 'launchd') {
    const name = `dev.scream-code.host.${key}`;
    return {
      manager,
      name,
      launcher: join(binDir, 'scream-host.sh'),
      definition: join(homedir(), 'Library', 'LaunchAgents', `${name}.plist`),
    };
  }
  if (manager === 'systemd') {
    const name = `scream-host-${key}.service`;
    const configHome = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
    return {
      manager,
      name,
      launcher: join(binDir, 'scream-host.sh'),
      definition: join(configHome, 'systemd', 'user', name),
    };
  }
  return { manager, name: `ScreamHost-${key}`, launcher: join(binDir, 'scream-host.cmd'), definition: undefined };
}

// ─── Launcher ────────────────────────────────────────────────────────────

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The launcher script for the current runtime (node, entry file, PATH, home). */
export function renderLauncher(manager: ServiceManager, input: {
  readonly node: string;
  readonly execArgv: readonly string[];
  readonly entry: string;
  readonly home: string;
  readonly path: string;
  readonly log: string;
}): string {
  if (manager === 'schtasks') {
    const args = [...input.execArgv, input.entry].map((arg) => `"${arg}"`).join(' ');
    return [
      '@echo off',
      // The file is written as UTF-8, but cmd.exe reads a batch file in the
      // console's code page (936 on Chinese Windows, 932 on Japanese...): a
      // profile such as C:\Users\张三 would turn into mojibake in the lines
      // below. Switching to UTF-8 first makes cmd read the rest as written;
      // everything up to here is ASCII.
      'chcp 65001 >nul',
      'rem Written by `scream service install`; rewritten when scream or node moves.',
      `set "PATH=${input.path}"`,
      `set "SCREAM_CODE_HOME=${input.home}"`,
      'set "SCREAM_CODE_HOST_SERVICE=1"',
      `"${input.node}" ${args} host >> "${input.log}" 2>&1`,
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    '# Written by `scream service install`; rewritten when scream or node moves.',
    `PATH=${shellQuote(input.path)}`,
    'export PATH',
    `SCREAM_CODE_HOME=${shellQuote(input.home)}`,
    'export SCREAM_CODE_HOME',
    'SCREAM_CODE_HOST_SERVICE=1',
    'export SCREAM_CODE_HOST_SERVICE',
    `exec ${[input.node, ...input.execArgv, input.entry].map(shellQuote).join(' ')} host >> ${shellQuote(input.log)} 2>&1`,
    '',
  ].join('\n');
}

function currentLauncher(manager: ServiceManager): string | undefined {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return undefined;
  return renderLauncher(manager, {
    node: process.execPath,
    execArgv: process.execArgv,
    entry: resolve(entry),
    home: getDataDir(),
    path: process.env['PATH'] ?? '',
    log: getHostLogFile(),
  });
}

async function writeLauncher(paths: ServicePaths): Promise<boolean> {
  const content = currentLauncher(paths.manager);
  if (content === undefined) return false;
  const existing = await readFile(paths.launcher, 'utf8').catch(() => undefined);
  if (existing === content) return false;
  await mkdir(join(getDataDir(), 'bin'), { recursive: true });
  await mkdir(join(getDataDir(), 'host'), { recursive: true });
  await writeFile(paths.launcher, content, { encoding: 'utf8', mode: 0o700 });
  await chmod(paths.launcher, 0o700).catch(() => {});
  return true;
}

/**
 * Keep an installed service's launcher pointing at the scream that runs now
 * (called on every start). Does nothing when no service is installed.
 */
export async function refreshServiceLauncher(): Promise<void> {
  const paths = servicePaths();
  if (paths === undefined) return;
  const installed = await readFile(paths.launcher, 'utf8').catch(() => undefined);
  if (installed === undefined) return;
  await writeLauncher(paths).catch(() => {});
}

// ─── Definitions ─────────────────────────────────────────────────────────

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderLaunchAgent(label: string, launcher: string): string {
  // KeepAlive.SuccessfulExit=false: restarted after a crash, left stopped
  // after a clean `scream host stop` (exit 0) until the next login.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xmlEscape(launcher)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(launcher: string): string {
  // Restart=on-failure: restarted after a crash, left stopped after a clean
  // `scream host stop` (exit 0).
  return `[Unit]
Description=Scream background host
After=network-online.target

[Service]
Type=simple
ExecStart=/bin/sh ${launcher.includes(' ') ? `"${launcher}"` : launcher}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

// ─── Install / uninstall / status ────────────────────────────────────────

async function run(command: string, args: readonly string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      timeout: 30_000,
      windowsHide: true,
    });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim();
    return { ok: false, output: output === '' ? (failure.message ?? String(error)) : output };
  }
}

function launchdDomain(): string {
  return `gui/${String(userInfo().uid)}`;
}

async function lingerEnabled(): Promise<boolean | undefined> {
  const result = await run('loginctl', ['show-user', userInfo().username, '--property=Linger']);
  if (!result.ok) return undefined;
  return result.output.includes('Linger=yes');
}

export async function readServiceStatus(): Promise<ServiceStatus> {
  const paths = servicePaths();
  if (paths === undefined) return { manager: undefined, installed: false };
  if (paths.manager === 'launchd') {
    const loaded = await run('launchctl', ['print', `${launchdDomain()}/${paths.name}`]);
    return { manager: paths.manager, installed: loaded.ok };
  }
  if (paths.manager === 'systemd') {
    const enabled = await run('systemctl', ['--user', 'is-enabled', paths.name]);
    const installed = enabled.ok && enabled.output.startsWith('enabled');
    return { manager: paths.manager, installed, linger: installed ? await lingerEnabled() : undefined };
  }
  const query = await run('schtasks', ['/Query', '/TN', paths.name]);
  return { manager: paths.manager, installed: query.ok };
}

/**
 * Install the service and start it. A host already running (started by a
 * terminal) is stopped first, so the service's host is the one that holds the
 * lock from now on.
 */
export async function installService(): Promise<ServiceResult> {
  const paths = servicePaths();
  if (paths === undefined) return { ok: false, error: `unsupported platform: ${process.platform}` };
  await writeLauncher(paths);
  await stopHost().catch(() => false);

  if (paths.manager === 'launchd') {
    const plist = paths.definition!;
    await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(plist, renderLaunchAgent(paths.name, paths.launcher), 'utf8');
    // Replace a previous definition: bootout fails harmlessly when none is loaded.
    await run('launchctl', ['bootout', `${launchdDomain()}/${paths.name}`]);
    const loaded = await run('launchctl', ['bootstrap', launchdDomain(), plist]);
    if (!loaded.ok) {
      // Older macOS: the pre-bootstrap verbs.
      const legacy = await run('launchctl', ['load', '-w', plist]);
      if (!legacy.ok) return { ok: false, error: loaded.output };
    }
    return { ok: true };
  }

  if (paths.manager === 'systemd') {
    const unit = paths.definition!;
    await mkdir(join(unit, '..'), { recursive: true });
    await writeFile(unit, renderSystemdUnit(paths.launcher), 'utf8');
    const reload = await run('systemctl', ['--user', 'daemon-reload']);
    if (!reload.ok) return { ok: false, error: reload.output };
    const enabled = await run('systemctl', ['--user', 'enable', '--now', paths.name]);
    if (!enabled.ok) return { ok: false, error: enabled.output };
    return { ok: true, lingerOff: (await lingerEnabled()) === false };
  }

  // Windows: a logon task running the launcher in a hidden console. The task
  // command line is limited to 261 characters, hence the launcher file.
  const taskCommand = `conhost.exe --headless cmd.exe /d /c "${paths.launcher}"`;
  const created = await run('schtasks', [
    '/Create',
    '/TN',
    paths.name,
    '/TR',
    taskCommand,
    '/SC',
    'ONLOGON',
    '/RL',
    'LIMITED',
    '/F',
  ]);
  if (!created.ok) return { ok: false, error: created.output };
  const started = await run('schtasks', ['/Run', '/TN', paths.name]);
  if (!started.ok) {
    // The task exists and runs at the next logon; start this session's host now.
    await startHostDetached().catch(() => {});
  }
  return { ok: true };
}

/** Remove the service (and stop its host). The Scream home and its data stay. */
export async function uninstallService(): Promise<ServiceResult> {
  const paths = servicePaths();
  if (paths === undefined) return { ok: false, error: `unsupported platform: ${process.platform}` };
  let error: string | undefined;
  if (paths.manager === 'launchd') {
    await run('launchctl', ['bootout', `${launchdDomain()}/${paths.name}`]);
    await rm(paths.definition!, { force: true });
  } else if (paths.manager === 'systemd') {
    const disabled = await run('systemctl', ['--user', 'disable', '--now', paths.name]);
    if (!disabled.ok && !/not loaded|does not exist|No such file/i.test(disabled.output)) error = disabled.output;
    await rm(paths.definition!, { force: true });
    await run('systemctl', ['--user', 'daemon-reload']);
  } else {
    const deleted = await run('schtasks', ['/Delete', '/TN', paths.name, '/F']);
    if (!deleted.ok && !/cannot find|找不到/i.test(deleted.output)) error = deleted.output;
  }
  await stopHost().catch(() => false);
  await rm(paths.launcher, { force: true });
  return error === undefined ? { ok: true } : { ok: false, error };
}

/** Restart the installed service's host (or start one when none runs). */
export async function restartService(): Promise<ServiceResult> {
  const paths = servicePaths();
  if (paths === undefined) return { ok: false, error: `unsupported platform: ${process.platform}` };
  await writeLauncher(paths).catch(() => false);
  if (paths.manager === 'launchd') {
    const kicked = await run('launchctl', ['kickstart', '-k', `${launchdDomain()}/${paths.name}`]);
    return kicked.ok ? { ok: true } : { ok: false, error: kicked.output };
  }
  if (paths.manager === 'systemd') {
    const restarted = await run('systemctl', ['--user', 'restart', paths.name]);
    return restarted.ok ? { ok: true } : { ok: false, error: restarted.output };
  }
  await stopHost().catch(() => false);
  const started = await run('schtasks', ['/Run', '/TN', paths.name]);
  return started.ok ? { ok: true } : { ok: false, error: started.output };
}
