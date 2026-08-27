import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PluginManager } from '../../src/plugin/manager';
import { compareManifestVersions } from '../../src/plugin/source';

/**
 * Upgrade mechanics: single-slot backup under plugins/backups/<id>/, swap,
 * reload; manual rollback restores the slot. Version comparison is a soft
 * warning, never a blocker.
 */

async function makeManager(): Promise<{ manager: PluginManager; home: string }> {
  const home = await mkdtemp(path.join(tmpdir(), 'upgrade-home-'));
  const manager = new PluginManager({ screamHomeDir: home });
  await manager.load();
  return { manager, home };
}

async function makePluginDir(version: string | undefined, marker: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `plug-${marker}-`));
  const manifest: Record<string, unknown> = { name: 'widget', ...(version !== undefined ? { version } : {}) };
  await writeFile(path.join(root, 'scream.plugin.json'), JSON.stringify(manifest), 'utf8');
  await mkdir(path.join(root, 'skills'), { recursive: true });
  await writeFile(
    path.join(root, 'SKILL.md'),
    `---\nname: widget\ndescription: d\n---\nMARKER:${marker}`,
    'utf8',
  );
  return root;
}

function managedSkill(home: string): Promise<string> {
  return readFile(path.join(home, 'plugins', 'managed', 'widget', 'SKILL.md'), 'utf8');
}

describe('PluginManager.upgrade/rollback', () => {
  it('upgrade swaps files, records the transition, and keeps a backup', async () => {
    const { manager, home } = await makeManager();
    await manager.install(await makePluginDir('0.1.0', 'OLD'));

    const result = await manager.upgrade(await makePluginDir('0.2.0', 'NEW'));

    expect(result.from).toBe('0.1.0');
    expect(result.to).toBe('0.2.0');
    expect(result.record.manifest?.version).toBe('0.2.0');
    expect(await managedSkill(home)).toContain('MARKER:NEW');
    expect(result.record.diagnostics.some((d) => d.message.startsWith('upgraded '))).toBe(true);
    expect(result.backupPath).toContain(path.join('plugins', 'backups', 'widget'));
  });

  it('rollback restores the previous contents', async () => {
    const { manager, home } = await makeManager();
    await manager.install(await makePluginDir('0.1.0', 'OLD'));
    await manager.upgrade(await makePluginDir('0.2.0', 'NEW'));

    const restored = await manager.rollback('widget');

    expect(restored.record.manifest?.version).toBe('0.1.0');
    expect(await managedSkill(home)).toContain('MARKER:OLD');
    expect(restored.record.diagnostics.some((d) => d.message.startsWith('rolled back'))).toBe(
      true,
    );
  });

  it('rollback restores the pre-upgrade source metadata, not just files', async () => {
    const { manager } = await makeManager();
    const oldSource = await makePluginDir('0.1.0', 'OLD');
    const newSource = await makePluginDir('0.2.0', 'NEW');
    const before = await manager.install(oldSource);
    const originalSource = before.originalSource;

    await manager.upgrade(newSource);
    const afterUpgrade = manager.get('widget');
    // Upgrade records the NEW source onto the record.
    expect(afterUpgrade?.originalSource).not.toBe(originalSource);

    const restored = await manager.rollback('widget');
    // Files AND provenance return together.
    expect(restored.record.originalSource).toBe(originalSource);
  });

  it('upgrade refuses unknown ids without touching anything', async () => {
    const { manager } = await makeManager();
    await expect(manager.upgrade(await makePluginDir('9.9.9', 'X'))).rejects.toThrow(
      /not installed/,
    );
  });

  it('a second upgrade keeps exactly one backup slot per id', async () => {
    const { manager, home } = await makeManager();
    await manager.install(await makePluginDir('0.1.0', 'A'));
    await manager.upgrade(await makePluginDir('0.2.0', 'B'));
    await manager.upgrade(await makePluginDir('0.3.0', 'C'));

    const slots = await readdir(path.join(home, 'plugins', 'backups', 'widget'));
    expect(slots).toHaveLength(1);
    // The surviving slot must be the one taken during the latest upgrade
    // (i.e. the v0.2.0 snapshot), so rollback returns to the previous version.
    const restored = await manager.rollback('widget');
    expect(restored.record.manifest?.version).toBe('0.2.0');
  });

  it('pruning keeps the NEWEST backup when version tags sort before older ones', async () => {
    // Regression: backup dirs are ordered by time, not by the version label.
    // 0.10.0 sorts lexicographically BEFORE 0.9.0, so a naive name sort would
    // delete the fresh backup and keep the stale one.
    const { manager, home } = await makeManager();
    await manager.install(await makePluginDir('0.9.0', 'NINE'));
    await manager.upgrade(await makePluginDir('0.10.0', 'TEN'));
    await manager.upgrade(await makePluginDir('0.11.0', 'ELEVEN'));

    const slots = await readdir(path.join(home, 'plugins', 'backups', 'widget'));
    expect(slots).toHaveLength(1);
    // The last upgrade captured the pre-upgrade (0.10.0) contents.
    const restored = await manager.rollback('widget');
    expect(restored.record.manifest?.version).toBe('0.10.0');
    expect(await managedSkill(home)).toContain('MARKER:TEN');
  });

  it('missing version strings still upgrade, flagged as unknown', async () => {
    const { manager } = await makeManager();
    await manager.install(await makePluginDir(undefined, 'BASE'));
    const result = await manager.upgrade(await makePluginDir(undefined, 'NEXT'));
    expect(result.from).toBeUndefined();
    expect(result.to).toBeUndefined();
    expect(result.warn).toBe('unknown');
  });

  it('downgrades are allowed but warned', async () => {
    const { manager } = await makeManager();
    await manager.install(await makePluginDir('0.2.0', 'NEWER'));
    const result = await manager.upgrade(await makePluginDir('0.1.0', 'OLDER'));
    expect(result.warn).toBe('downgrade');
    expect(result.record.manifest?.version).toBe('0.1.0');
  });
});

describe('compareManifestVersions', () => {
  it('orders numeric dotted segments and yields undefined on junk', () => {
    expect(compareManifestVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareManifestVersions('v2.0', '1.9.9')).toBe(1);
    expect(compareManifestVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareManifestVersions('abc', '1.0.0')).toBeUndefined();
    expect(compareManifestVersions(undefined, '1.0.0')).toBeUndefined();
  });
});
