import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PluginManager } from '../../src/plugin/manager';

describe('PluginManager → SkillRegistry integration', () => {
  it('enabled plugin contributes to pluginSkillRoots()', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'scream-home-'));
    const pluginRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'plugin-')));
    await writeFile(
      path.join(pluginRoot, 'scream.plugin.json'),
      JSON.stringify({ name: 'demo', skills: './skills/' }),
      'utf8',
    );
    await mkdir(path.join(pluginRoot, 'skills', 'demo-skill'), { recursive: true });
    await writeFile(
      path.join(pluginRoot, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: demo\n---\nbody',
      'utf8',
    );
    const manager = new PluginManager({ screamHomeDir: home });
    await manager.load();
    await manager.install(pluginRoot);
    const managedRoot = await realpath(path.join(home, 'plugins', 'managed', 'demo'));

    expect(manager.pluginSkillRoots()).toContainEqual({
      path: path.join(managedRoot, 'skills'),
      source: 'extra',
      plugin: { id: 'demo', instructions: undefined },
    });
  });

  it('records skill discovery failures as plugin warnings, not errors', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'scream-home-'));
    const pluginRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'plugin-')));
    await writeFile(
      path.join(pluginRoot, 'scream.plugin.json'),
      JSON.stringify({ name: 'demo' }),
      'utf8',
    );
    // Root SKILL.md with broken frontmatter: an unquoted `: ` inside the
    // description makes the YAML unparseable (the real-world tod case).
    await writeFile(
      path.join(pluginRoot, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Core mechanisms: external-anchor\n---\nbody',
      'utf8',
    );
    const manager = new PluginManager({ screamHomeDir: home });
    await manager.load();
    await manager.install(pluginRoot);

    const record = manager.get('demo');
    expect(record).toBeDefined();
    // The manifest is fine — only the skill is damaged: state stays ok and no
    // error diagnostic is invented, but the reason is now on the record.
    expect(record!.state).toBe('ok');
    expect(record!.skillCount).toBe(0);
    expect(record!.diagnostics.some((d) => d.severity === 'error')).toBe(false);
    const warns = record!.diagnostics.filter((d) => d.severity === 'warn');
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]!.message).toContain('Skipping invalid skill');
    expect(warns[0]!.message).toContain('bad indentation of a mapping entry');
  });
});
