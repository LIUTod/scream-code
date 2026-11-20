/**
 * Keeps the computer from falling asleep while scream works, on mains power.
 *
 * A laptop left alone idles into sleep after a few minutes, and a turn, a
 * goal or a scheduled task then stops until someone wakes it. While work is in
 * flight the host holds a sleep inhibitor — `caffeinate -i` on macOS,
 * `systemd-inhibit` on Linux, `SetThreadExecutionState` on Windows — and
 * releases it as soon as nothing runs. The inhibitor is a child process that
 * watches the host's pid and ends when the host is gone, however it went (a
 * crash, a forced exit, SIGKILL): `caffeinate -w` on macOS, a `kill -0` loop
 * under `systemd-inhibit` on Linux, a `Get-Process` check in the PowerShell
 * loop on Windows. So a dead host never leaves a machine that cannot sleep.
 *
 * On battery nothing is held: draining a laptop to keep a task going is not
 * what anybody asked for. What this cannot do: a laptop still sleeps when its
 * lid is closed (unless an external display is attached), and a system the
 * person told to sleep still sleeps. The `/service` panel says so — on
 * machines that have a lid, which is what `machineHasBattery` answers.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function windowsInhibitor(parentPid: number): string {
  return [
    "$s='[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
    '$k=Add-Type -MemberDefinition $s -Name Power -Namespace Scream -PassThru',
    'Add-Type -AssemblyName System.Windows.Forms',
    // ES_CONTINUOUS|ES_SYSTEM_REQUIRED on mains power; ES_CONTINUOUS alone (no
    // request) on battery. The state ends with this process, which ends when
    // the host is gone.
    `while(Get-Process -Id ${String(parentPid)} -ErrorAction SilentlyContinue){ if([System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus -ne 'Offline'){ [void]$k::SetThreadExecutionState(0x80000001) } else { [void]$k::SetThreadExecutionState(0x80000000) }; Start-Sleep -Seconds 15 }`,
  ].join('; ');
}

/** The command that holds a sleep inhibitor until it is killed, per platform. */
export function inhibitorCommand(
  platform: NodeJS.Platform,
  parentPid: number,
): { command: string; args: string[] } | undefined {
  if (platform === 'darwin') return { command: 'caffeinate', args: ['-i', '-w', String(parentPid)] };
  if (platform === 'linux') {
    return {
      command: 'systemd-inhibit',
      args: [
        '--what=idle:sleep',
        '--who=scream',
        '--why=Scream is running a task',
        '--mode=block',
        // Held while the host lives: ends within 15 s of the host going away.
        'sh',
        '-c',
        `while kill -0 ${String(parentPid)} 2>/dev/null; do sleep 15; done`,
      ],
    };
  }
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', windowsInhibitor(parentPid)],
    };
  }
  return undefined;
}

/**
 * Whether the machine runs on mains power. A machine with no battery (a
 * desktop, a server) is on mains. When the answer cannot be read, assume mains:
 * the inhibitor then behaves as the person asked. Windows decides inside its
 * inhibitor loop instead, every 30 seconds.
 */
export async function onMainsPower(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    if (platform === 'darwin') {
      const { stdout } = await execFileAsync('pmset', ['-g', 'batt'], { timeout: 5_000 });
      return !stdout.includes("'Battery Power'");
    }
    if (platform === 'linux') return linuxOnMains('/sys/class/power_supply');
  } catch {
    return true;
  }
  return true;
}

export interface LinuxPowerState {
  /** A battery is present, i.e. this is a machine with a lid. */
  readonly hasBattery: boolean;
  /** Some mains/USB supply reports itself online. */
  readonly mainsOnline: boolean;
}

/** Reads the Linux power-supply tree once (battery presence and mains state). */
export function linuxPowerState(root: string): LinuxPowerState {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return { hasBattery: false, mainsOnline: false };
  }
  let hasBattery = false;
  let mainsOnline = false;
  for (const name of names) {
    const read = (file: string): string => {
      try {
        return readFileSync(join(root, name, file), 'utf8').trim();
      } catch {
        return '';
      }
    };
    const type = read('type');
    if (type === 'Battery') hasBattery = true;
    if ((type === 'Mains' || type === 'USB') && read('online') === '1') mainsOnline = true;
  }
  return { hasBattery, mainsOnline };
}

/** Linux: on mains unless a battery exists and no mains supply reports online. */
export function linuxOnMains(root: string): boolean {
  const { hasBattery, mainsOnline } = linuxPowerState(root);
  return !hasBattery || mainsOnline;
}

/**
 * Whether this machine has a battery — that is, whether it has a lid that can
 * be closed while work is running.
 *
 * Only that case needs the caveat in `/service`: a desktop has no lid, so
 * spelling the limitation out there is noise about hardware the person does not
 * have. `undefined` means "could not tell" (no probe on this platform, or the
 * probe failed) and callers stay quiet rather than claim something they cannot
 * see.
 */
export async function machineHasBattery(platform: NodeJS.Platform = process.platform): Promise<boolean | undefined> {
  try {
    if (platform === 'darwin') {
      const { stdout } = await execFileAsync('pmset', ['-g', 'batt'], { timeout: 5_000 });
      return stdout.includes('InternalBattery');
    }
    if (platform === 'linux') return linuxPowerState('/sys/class/power_supply').hasBattery;
  } catch {
    return undefined;
  }
  return undefined;
}

export interface KeepAwakeOptions {
  readonly platform?: NodeJS.Platform;
  readonly onMains?: () => Promise<boolean>;
  readonly spawnInhibitor?: (command: string, args: string[]) => ChildProcess;
}

export class KeepAwake {
  private child: ChildProcess | undefined;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: KeepAwakeOptions = {}) {
    this.platform = options.platform ?? process.platform;
  }

  /** Whether an inhibitor is held right now. */
  get holding(): boolean {
    return this.child !== undefined;
  }

  /** Hold the inhibitor while `working` (and on mains power); release it otherwise. */
  async update(working: boolean): Promise<void> {
    const want = working && (await (this.options.onMains ?? (() => onMainsPower(this.platform)))());
    if (want && this.child === undefined) {
      const spec = inhibitorCommand(this.platform, process.pid);
      if (spec === undefined) return;
      const spawnFn =
        this.options.spawnInhibitor ??
        ((command: string, args: string[]) =>
          spawn(command, args, { stdio: 'ignore', windowsHide: true }));
      try {
        const child = spawnFn(spec.command, spec.args);
        child.on('error', () => {
          // Not installed (no systemd, no caffeinate): nothing to hold.
          if (this.child === child) this.child = undefined;
        });
        child.on('exit', () => {
          if (this.child === child) this.child = undefined;
        });
        this.child = child;
      } catch {
        this.child = undefined;
      }
    } else if (!want && this.child !== undefined) {
      this.release();
    }
  }

  release(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }
}
