import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { inhibitorCommand, KeepAwake, linuxOnMains, linuxPowerState, machineHasBattery } from '#/host/keep-awake';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function supplies(entries: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'power-supply-'));
  dirs.push(root);
  for (const [name, files] of Object.entries(entries)) {
    mkdirSync(join(root, name));
    for (const [file, value] of Object.entries(files)) writeFileSync(join(root, name, file), `${value}\n`);
  }
  return root;
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess & { killed: boolean };
  (child as { kill: () => boolean }).kill = vi.fn(() => true);
  return child;
}

describe('inhibitorCommand', () => {
  it('ties the macOS inhibitor to the host pid and uses systemd-inhibit on Linux', () => {
    expect(inhibitorCommand('darwin', 4242)).toEqual({ command: 'caffeinate', args: ['-i', '-w', '4242'] });
    expect(inhibitorCommand('linux', 1)?.command).toBe('systemd-inhibit');
    expect(inhibitorCommand('win32', 1)?.args.join(' ')).toContain('SetThreadExecutionState');
    expect(inhibitorCommand('aix', 1)).toBeUndefined();
  });
});

describe('linuxOnMains', () => {
  it('is on mains without a battery, or with a mains supply online', () => {
    expect(linuxOnMains(supplies({}))).toBe(true);
    expect(linuxOnMains(supplies({ AC: { type: 'Mains', online: '1' }, BAT0: { type: 'Battery' } }))).toBe(true);
  });

  it('is on battery when a battery exists and no mains supply is online', () => {
    expect(linuxOnMains(supplies({ AC: { type: 'Mains', online: '0' }, BAT0: { type: 'Battery' } }))).toBe(false);
  });
});

describe('machineHasBattery', () => {
  it('finds a battery in the Linux power-supply tree', () => {
    expect(linuxPowerState(supplies({ AC: { type: 'Mains', online: '1' } })).hasBattery).toBe(false);
    expect(
      linuxPowerState(supplies({ AC: { type: 'Mains', online: '1' }, BAT0: { type: 'Battery' } })).hasBattery,
    ).toBe(true);
  });

  it('answers "cannot tell" on a platform it has no probe for', async () => {
    // Unknown must stay unknown: the /service lid caveat is hidden on it rather
    // than describing hardware the person may not have.
    await expect(machineHasBattery('aix')).resolves.toBeUndefined();
  });
});

describe('KeepAwake', () => {
  it('holds the inhibitor only while work runs on mains power, and releases it after', async () => {
    const child = fakeChild();
    const spawnInhibitor = vi.fn(() => child);
    let mains = true;
    const keepAwake = new KeepAwake({ platform: 'darwin', onMains: async () => mains, spawnInhibitor });

    await keepAwake.update(false);
    expect(spawnInhibitor).not.toHaveBeenCalled();

    await keepAwake.update(true);
    await keepAwake.update(true);
    expect(spawnInhibitor).toHaveBeenCalledTimes(1);
    expect(keepAwake.holding).toBe(true);

    mains = false;
    await keepAwake.update(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(keepAwake.holding).toBe(false);
  });

  it('forgets an inhibitor that could not start (not installed)', async () => {
    const child = fakeChild();
    const keepAwake = new KeepAwake({ platform: 'linux', onMains: async () => true, spawnInhibitor: () => child });
    await keepAwake.update(true);
    (child as unknown as EventEmitter).emit('error', new Error('ENOENT'));
    expect(keepAwake.holding).toBe(false);
  });
});
