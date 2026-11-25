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
 * so: macOS and Windows start it at login; Linux starts it at boot when
 * lingering is on for the user (install turns it on where that needs no
 * password, see {@link ensureLinger}), and at login otherwise.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { getDataDir } from '#/utils/paths';

import { launcherFingerprint, readHostCheck, type HostCheckResult } from './check';
import {
  getHostLogFile,
  HOST_START_TIMEOUT_MS,
  readHostStatus,
  startHostDetached,
  stopHost,
  waitForHostHolder,
} from './control';

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
  /** After install: whether the service's own environment reaches the model. */
  readonly check?: HostCheckResult | undefined;
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

/**
 * The launcher's shape. Bumped when it changes; a launcher of an older shape
 * is rewritten in place with the node and scream it already points at (see
 * {@link planLauncherRefresh}). Format 2 passes its arguments on (so
 * `scream-host.sh check` runs the check, not a host) and carries the network
 * settings a service would otherwise lack.
 */
export const LAUNCHER_FORMAT = 2;
const FORMAT_MARK = 'scream-launcher-format';

/**
 * Settings a service starts without that decide whether the model can be
 * reached at all: a company CA, a proxy, the locale. Copied from the shell
 * that writes the launcher when they are set. Keys and tokens never are: a key
 * belongs in Scream's own credentials (`/login`), not in a script on disk.
 */
const PASSTHROUGH_ENV = [
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
  'no_proxy',
  'LANG',
  'LC_ALL',
] as const;

/** The pass-through settings set in `env` (see {@link PASSTHROUGH_ENV}). */
export function launcherEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of PASSTHROUGH_ENV) {
    // Windows has one namespace for both spellings.
    if (platform === 'win32' && name !== name.toUpperCase()) continue;
    const value = env[name];
    if (value === undefined || value.trim() === '' || /[\r\n]/.test(value)) continue;
    // A proxy address with a user name or password in it carries a secret.
    if (/proxy$/i.test(name) && /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(value)) continue;
    picked[name] = value;
  }
  return picked;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A value inside `set "NAME=value"` in a batch file: `%` would expand. */
function batchValue(value: string): string {
  return value.replaceAll('%', '%%');
}

export interface LauncherInput {
  readonly node: string;
  readonly execArgv: readonly string[];
  readonly entry: string;
  readonly home: string;
  readonly path: string;
  readonly log: string;
  /** Pass-through settings ({@link launcherEnv}); none when omitted. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** The launcher script for a runtime (node, entry file, PATH, home). */
export function renderLauncher(manager: ServiceManager, input: LauncherInput): string {
  const env = Object.entries(input.env ?? {});
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
      `rem Written by \`scream service install\`. ${FORMAT_MARK} ${String(LAUNCHER_FORMAT)}`,
      `set "PATH=${batchValue(input.path)}"`,
      `set "SCREAM_CODE_HOME=${batchValue(input.home)}"`,
      'set "SCREAM_CODE_HOST_SERVICE=1"',
      ...env.map(([name, value]) => `set "${name}=${batchValue(value)}"`),
      `"${input.node}" ${args} host %* >> "${input.log}" 2>&1`,
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    `# Written by \`scream service install\`. ${FORMAT_MARK} ${String(LAUNCHER_FORMAT)}`,
    `PATH=${shellQuote(input.path)}`,
    'export PATH',
    `SCREAM_CODE_HOME=${shellQuote(input.home)}`,
    'export SCREAM_CODE_HOME',
    'SCREAM_CODE_HOST_SERVICE=1',
    'export SCREAM_CODE_HOST_SERVICE',
    ...env.flatMap(([name, value]) => [`${name}=${shellQuote(value)}`, `export ${name}`]),
    `exec ${[input.node, ...input.execArgv, input.entry].map(shellQuote).join(' ')} host "$@" >> ${shellQuote(input.log)} 2>&1`,
    '',
  ].join('\n');
}

/** What a launcher on disk runs: its node, the arguments before scream's entry, the entry, its PATH. */
export interface LauncherRuntime {
  readonly format: number;
  readonly node: string;
  readonly execArgv: readonly string[];
  readonly entry: string;
  readonly path: string | undefined;
}

/** Read a launcher back (any format); undefined when it is not one of ours. */
export function parseLauncher(content: string, manager: ServiceManager): LauncherRuntime | undefined {
  const format = Number(new RegExp(`${FORMAT_MARK} (\\d+)`).exec(content)?.[1] ?? '1');
  if (manager === 'schtasks') {
    const command = content.split(/\r?\n/).find((line) => line.startsWith('"') && line.includes(' host'));
    if (command === undefined) return undefined;
    const tokens = [...command.slice(0, command.indexOf('" host') + 1).matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
    const path = /^set "PATH=(.*)"$/m.exec(content)?.[1]?.replaceAll('%%', '%');
    return tokens.length < 2
      ? undefined
      : { format, node: tokens[0]!, execArgv: tokens.slice(1, -1), entry: tokens.at(-1)!, path };
  }
  const command = content.split('\n').find((line) => line.startsWith('exec '));
  if (command === undefined) return undefined;
  const unquote = (token: string): string => token.slice(1, -1).replaceAll(`'\\''`, "'");
  const head = command.slice(0, command.indexOf("' host") + 1);
  const tokens = [...head.matchAll(/'(?:[^']|'\\'')*'/g)].map((m) => unquote(m[0]));
  const pathToken = /^PATH=('(?:[^']|'\\'')*')$/m.exec(content)?.[1];
  return tokens.length < 2
    ? undefined
    : {
        format,
        node: tokens[0]!,
        execArgv: tokens.slice(1, -1),
        entry: tokens.at(-1)!,
        path: pathToken === undefined ? undefined : unquote(pathToken),
      };
}

/** Running scream from its sources (`tsx src/main.ts`), not from an install. */
export function isSourceEntry(entry: string): boolean {
  return /\.[cm]?tsx?$/i.test(entry);
}

export type LauncherPlan =
  | { readonly kind: 'keep' }
  | { readonly kind: 'write'; readonly input: LauncherInput; readonly reason: 'missing' | 'broken' | 'format' };

/**
 * Whether a start should rewrite the service's launcher, and with what.
 *
 * A launcher is repaired, never re-pointed: it keeps running the scream it
 * was installed with for as long as that still exists. It used to follow
 * whichever scream started last, so running a checkout from its sources once
 * moved the person's resident service onto that checkout, and the next
 * installed start moved it back. `scream service install` is how a person
 * points it somewhere else.
 *
 * - no launcher, or not one we can read, or its node or entry is gone: write
 *   the current runtime — unless the current run is from sources, which must
 *   never become the service;
 * - an older format: rewrite it in the new shape around the node, arguments,
 *   entry and PATH it already has;
 * - otherwise keep it as it is.
 */
export function planLauncherRefresh(
  existing: string | undefined,
  manager: ServiceManager,
  current: LauncherInput | undefined,
  exists: (path: string) => boolean,
): LauncherPlan {
  const parsed = existing === undefined ? undefined : parseLauncher(existing, manager);
  const canUseCurrent = current !== undefined && !isSourceEntry(current.entry);
  if (parsed === undefined) return canUseCurrent ? { kind: 'write', input: current, reason: 'missing' } : { kind: 'keep' };
  if (!exists(parsed.node) || !exists(parsed.entry)) {
    return canUseCurrent ? { kind: 'write', input: current, reason: 'broken' } : { kind: 'keep' };
  }
  if (parsed.format < LAUNCHER_FORMAT && current !== undefined) {
    return {
      kind: 'write',
      reason: 'format',
      input: {
        ...current,
        node: parsed.node,
        execArgv: parsed.execArgv,
        entry: parsed.entry,
        path: parsed.path ?? current.path,
      },
    };
  }
  return { kind: 'keep' };
}

function currentLauncherInput(): LauncherInput | undefined {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return undefined;
  return {
    node: process.execPath,
    execArgv: process.execArgv,
    entry: resolve(entry),
    home: getDataDir(),
    path: process.env['PATH'] ?? '',
    log: getHostLogFile(),
    env: launcherEnv(),
  };
}

async function writeLauncher(paths: ServicePaths, input: LauncherInput | undefined = currentLauncherInput()): Promise<boolean> {
  if (input === undefined) return false;
  const content = renderLauncher(paths.manager, input);
  const existing = await readFile(paths.launcher, 'utf8').catch(() => undefined);
  if (existing === content) return false;
  await mkdir(join(getDataDir(), 'bin'), { recursive: true });
  await mkdir(join(getDataDir(), 'host'), { recursive: true });
  await writeFile(paths.launcher, content, { encoding: 'utf8', mode: 0o700 });
  await chmod(paths.launcher, 0o700).catch(() => {});
  return true;
}

/**
 * Keep an installed service's launcher working (called on every start): repair
 * it when what it runs is gone, bring an old one up to the current shape.
 * Does nothing when no service is installed (see {@link planLauncherRefresh}).
 */
export async function refreshServiceLauncher(): Promise<void> {
  const paths = servicePaths();
  if (paths === undefined) return;
  // "Is a service installed?" is answered from the artifact each platform keeps
  // on disk — never by querying the supervisor: this runs on every start, and
  // `launchctl print` / `systemctl is-enabled` / `schtasks /Query` each cost a
  // subprocess (schtasks alone takes hundreds of milliseconds on Windows).
  //
  // The launcher's own presence used to be that answer, which inverted the one
  // case worth handling: a launcher deleted from `<home>/bin` (a pruned
  // directory, a home copied to another machine) made the check conclude "no
  // service here" and skip the repair forever, while the definition went on
  // executing a file that did not exist.
  if (!(await serviceDefinitionInstalled(paths))) return;
  const existing = await readFile(paths.launcher, 'utf8').catch(() => undefined);
  const plan = planLauncherRefresh(existing, paths.manager, currentLauncherInput(), existsSync);
  if (plan.kind === 'write') await writeLauncher(paths, plan.input).catch(() => {});
}

/**
 * Whether a service is installed, from the artifact the platform keeps on disk:
 * the plist / unit file where there is one, and the launcher itself on Windows,
 * which keeps the task in the scheduler rather than in a file beside it.
 */
async function serviceDefinitionInstalled(paths: ServicePaths): Promise<boolean> {
  if (paths.definition !== undefined) return existsSync(paths.definition);
  return (await readFile(paths.launcher, 'utf8').catch(() => undefined)) !== undefined;
}

// ─── Definitions ─────────────────────────────────────────────────────────

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderLaunchAgent(label: string, launcher: string): string {
  // KeepAlive.SuccessfulExit=false: restarted after a crash, left stopped after
  // a clean `scream host stop` (exit 0) until the next login. So `scream host`
  // must exit 0 once *any* host it was meant to be is running — including "the
  // service's own host already holds the lock" — and only keep exiting non-zero
  // while a terminal's host owns it, which is the one case worth retrying.
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

/**
 * Turn lingering on, so the user unit starts at boot rather than at the first
 * login — without it a headless server (or root on one) only runs the service
 * after someone logs in. Allowed without a password for root and, under the
 * default polkit policy, for a user in an active local session; elsewhere it
 * would ask for a password, which `--no-ask-password` turns into a plain
 * failure instead of a hang. Returns the linger state afterwards (undefined
 * when loginctl is missing). Uninstall leaves it on: lingering may have been
 * enabled for other reasons, and it costs nothing on its own.
 */
async function ensureLinger(): Promise<boolean | undefined> {
  const before = await lingerEnabled();
  if (before !== false) return before;
  await run('loginctl', ['--no-ask-password', 'enable-linger', userInfo().username]);
  return lingerEnabled();
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
    return { ok: true, check: await checkServiceEnvironment() };
  }

  if (paths.manager === 'systemd') {
    const unit = paths.definition!;
    await mkdir(join(unit, '..'), { recursive: true });
    await writeFile(unit, renderSystemdUnit(paths.launcher), 'utf8');
    const reload = await run('systemctl', ['--user', 'daemon-reload']);
    if (!reload.ok) return { ok: false, error: reload.output };
    const enabled = await run('systemctl', ['--user', 'enable', '--now', paths.name]);
    if (!enabled.ok) return { ok: false, error: enabled.output };
    return { ok: true, lingerOff: (await ensureLinger()) === false, check: await checkServiceEnvironment() };
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
  return { ok: true, check: await checkServiceEnvironment() };
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
  // Repair only: a restart from a checkout must not move the service onto it.
  await refreshServiceLauncher();
  // A host a terminal started holds the lock: restarting the service would
  // only make the service's host wait behind it. Stop it first, so the host
  // that runs afterwards is the service's own.
  const holder = await readHostStatus();
  if (holder.running && holder.service !== true) await stopHost().catch(() => false);
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

// ─── The service's own environment ───────────────────────────────────────

/**
 * Roughly what a service starts with on macOS and Linux: launchd and systemd
 * give a user agent its identity and little else — no shell profile, so no
 * exported key, CA or proxy. The launcher adds PATH, the home and the
 * pass-through settings itself. (Windows gives a logon task the user's stored
 * environment, which this process cannot tell apart from its own: there the
 * check runs with this environment.)
 */
function serviceLikeEnv(): NodeJS.ProcessEnv {
  if (process.platform === 'win32') return process.env;
  const kept: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const name of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    const value = process.env[name];
    if (value !== undefined) kept[name] = value;
  }
  return kept;
}

/**
 * Run `scream host check` through the service's launcher, in an environment
 * like the service's, and return what it found (it records it itself, see
 * `host/check.ts`). Undefined when there is no launcher of the current format
 * to run: an older launcher does not pass arguments on, and would start a
 * host instead of a check.
 */
export async function checkServiceEnvironment(): Promise<HostCheckResult | undefined> {
  const paths = servicePaths();
  if (paths === undefined) return undefined;
  const content = await readFile(paths.launcher, 'utf8').catch(() => undefined);
  const parsed = content === undefined ? undefined : parseLauncher(content, paths.manager);
  if (parsed === undefined || parsed.format < LAUNCHER_FORMAT) return undefined;
  const startedAt = Date.now();
  const options = { env: serviceLikeEnv(), timeout: 150_000, windowsHide: true };
  // A failed check exits non-zero: its result is in the file either way.
  if (paths.manager === 'schtasks') {
    // A batch file runs through cmd.exe; the path is quoted for it.
    await execFileAsync(`"${paths.launcher}"`, ['check'], { ...options, shell: true }).catch(() => {});
  } else {
    await execFileAsync('/bin/sh', [paths.launcher, 'check'], options).catch(() => {});
  }
  const result = readHostCheck();
  return result !== undefined && result.at >= startedAt - 1_000 ? result : undefined;
}

/**
 * Whether the installed service may be the one that starts the background:
 * a service is installed, and the last check run through its current launcher
 * reached the model. Files only, no subprocess.
 */
export async function serviceCanStartBackground(): Promise<boolean> {
  const paths = servicePaths();
  if (paths === undefined || !(await serviceDefinitionInstalled(paths))) return false;
  const content = await readFile(paths.launcher, 'utf8').catch(() => undefined);
  if (content === undefined) return false;
  const check = readHostCheck();
  return check?.ok === true && check.launcher === launcherFingerprint(content);
}

/** The fingerprint of the service launcher on disk (what a service-run check stamps). */
export async function serviceLauncherFingerprint(): Promise<string | undefined> {
  const paths = servicePaths();
  if (paths === undefined) return undefined;
  const content = await readFile(paths.launcher, 'utf8').catch(() => undefined);
  return content === undefined ? undefined : launcherFingerprint(content);
}

async function startServiceNow(paths: ServicePaths): Promise<boolean> {
  if (paths.manager === 'launchd') {
    // Without -k: start it when it is not running, leave it when it is.
    return (await run('launchctl', ['kickstart', `${launchdDomain()}/${paths.name}`])).ok;
  }
  if (paths.manager === 'systemd') return (await run('systemctl', ['--user', 'start', paths.name])).ok;
  return (await run('schtasks', ['/Run', '/TN', paths.name])).ok;
}

/**
 * Start the background: through the installed service when it can be trusted
 * to reach the model, otherwise as a process of this terminal's own.
 *
 * Every place that needs the background up goes through here. While a
 * service is installed, a host started by a terminal is the one thing that
 * fights it — the service's host then waits behind a lock it cannot take —
 * so the service starts it whenever it can. It is trusted only after a check
 * through its own launcher passed: a terminal has the person's environment, a
 * service does not, and switching to the service must never turn a working
 * background into one that cannot find its key. If the service does not come
 * up in time, the terminal starts the host itself, as before.
 */
export async function startBackground(): Promise<{ pid: number; alreadyRunning: boolean }> {
  const status = await readHostStatus();
  if (status.running && status.pid !== undefined) return { pid: status.pid, alreadyRunning: true };
  const paths = servicePaths();
  if (paths !== undefined && (await serviceCanStartBackground()) && (await startServiceNow(paths))) {
    const holder = await waitForHostHolder(HOST_START_TIMEOUT_MS);
    if (holder !== undefined) return { pid: holder, alreadyRunning: false };
  }
  return startHostDetached();
}

/** A failed check is tried again this much later, so a fixed key is noticed without a reinstall. */
const RECHECK_FAILED_MS = 6 * 60 * 60 * 1000;

/**
 * On a terminal start: when a service is installed but nothing says yet
 * whether its environment reaches the model (it was installed by a version
 * without the check, or its launcher changed since), run the check in the
 * background. Until it passes the terminal keeps starting the background
 * itself, as before. Cheap when there is nothing to do: file reads only.
 */
export async function ensureServiceChecked(now: number = Date.now()): Promise<void> {
  const paths = servicePaths();
  if (paths === undefined || !(await serviceDefinitionInstalled(paths))) return;
  const content = await readFile(paths.launcher, 'utf8').catch(() => undefined);
  if (content === undefined) return;
  const check = readHostCheck();
  const current = check?.launcher === launcherFingerprint(content);
  if (current && (check.ok || now - check.at < RECHECK_FAILED_MS)) return;
  await checkServiceEnvironment();
}
