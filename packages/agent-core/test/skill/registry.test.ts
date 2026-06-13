import { describe, expect, it } from 'vitest';

import { SkillRegistry } from '../../src/skill';
import type { SkillDefinition, SkillSource } from '../../src/skill';

describe('skill registry prompt rendering', () => {
  it('groups skills by scope under canonical section headings', () => {
    const registry = makeRegistry([
      makeSkill('builtin-a', 'builtin'),
      makeSkill('user-a', 'user'),
      makeSkill('proj-a', 'project'),
      makeSkill('extra-a', 'extra'),
    ]);

    const rendered = registry.getScreamSkillsDescription();

    expect(rendered).toContain('### Project');
    expect(rendered).toContain('### User');
    expect(rendered).toContain('### Extra');
    expect(rendered).toContain('### Built-in');

    const projectIdx = rendered.indexOf('### Project');
    const userIdx = rendered.indexOf('### User');
    const extraIdx = rendered.indexOf('### Extra');
    const builtinIdx = rendered.indexOf('### Built-in');
    expect(projectIdx).toBeLessThan(userIdx);
    expect(userIdx).toBeLessThan(extraIdx);
    expect(extraIdx).toBeLessThan(builtinIdx);

    expect(sectionFor(rendered, '### Project')).toContain('proj-a');
    expect(sectionFor(rendered, '### User')).toContain('user-a');
    expect(sectionFor(rendered, '### Extra')).toContain('extra-a');
    expect(sectionFor(rendered, '### Built-in')).toContain('builtin-a');
    expect(sectionFor(rendered, '### Project')).not.toContain('user-a');
    expect(sectionFor(rendered, '### User')).not.toContain('proj-a');
  });

  it('omits scope headings that have no skills', () => {
    const registry = makeRegistry([makeSkill('alpha', 'user')]);

    const rendered = registry.getScreamSkillsDescription();

    expect(rendered).toContain('### User');
    expect(rendered).not.toContain('### Project');
    expect(rendered).not.toContain('### Extra');
    expect(rendered).not.toContain('### Built-in');
  });

  it('renders a "No skills" placeholder for an empty registry', () => {
    const registry = new SkillRegistry();

    const rendered = registry.getScreamSkillsDescription();

    expect(rendered.trim()).not.toBe('');
    expect(/no skills/i.test(rendered)).toBe(true);
  });

  it('sorts skills alphabetically within a scope', () => {
    const registry = makeRegistry([
      makeSkill('zebra', 'user'),
      makeSkill('alpha', 'user'),
      makeSkill('mango', 'user'),
    ]);

    const rendered = registry.getScreamSkillsDescription();

    const a = rendered.indexOf('alpha');
    const m = rendered.indexOf('mango');
    const z = rendered.indexOf('zebra');
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(m);
    expect(m).toBeLessThan(z);
  });

  it('end-to-end: a project skill that shadows other scopes renders once under Project', () => {
    const registry = makeRegistry([makeSkill('foo', 'project', 'project version', '/tmp/proj/foo/SKILL.md')]);

    const rendered = registry.getScreamSkillsDescription();

    expect(rendered.match(/\n- foo\n/g) ?? []).toHaveLength(1);
    expect(sectionFor(rendered, '### Project')).toContain('foo');
    expect(rendered).toContain('/tmp/proj/foo/SKILL.md');
    expect(rendered).toContain('project version');
  });

  it('renders each skill as name + Path + Description', () => {
    const registry = makeRegistry([
      makeSkill('alpha', 'user', 'Alpha does things', '/tmp/user/alpha/SKILL.md'),
    ]);

    const rendered = registry.getScreamSkillsDescription();

    expect(rendered).toContain('- alpha');
    expect(rendered).toContain('  - Path: /tmp/user/alpha/SKILL.md');
    expect(rendered).toContain('  - Description: Alpha does things');
  });

  it('renames plugin skills on name collision so they remain distinguishable', () => {
    const warnings: string[] = [];
    const registry = new SkillRegistry({ onWarning: (msg) => warnings.push(msg) });

    registry.register(makeSkill('foo', 'user'));
    registry.register({ ...makeSkill('foo', 'extra'), plugin: { id: 'plugin-a' } });
    registry.register({ ...makeSkill('foo', 'extra'), plugin: { id: 'plugin-b' } });

    expect(registry.getSkill('foo')).toBeDefined();
    expect(registry.getSkill('plugin-a:foo')).toBeDefined();
    expect(registry.getSkill('plugin-b:foo')).toBeDefined();
    expect(registry.getPluginSkill('plugin-a', 'foo')).toBeDefined();
    expect(registry.getPluginSkill('plugin-b', 'foo')).toBeDefined();
    expect(registry.listSkills()).toHaveLength(3);
    expect(warnings.some((w) => w.includes('renamed'))).toBe(true);
  });

  it('keeps non-plugin skills shadowed without renaming them', () => {
    const warnings: string[] = [];
    const registry = new SkillRegistry({ onWarning: (msg) => warnings.push(msg) });

    registry.register(makeSkill('foo', 'user'));
    registry.register(makeSkill('foo', 'project'));

    expect(registry.listSkills()).toHaveLength(1);
    expect(warnings.some((w) => w.includes('shadowed'))).toBe(true);
  });
});

function makeRegistry(skills: readonly SkillDefinition[]): SkillRegistry {
  const registry = new SkillRegistry();
  for (const skill of skills) registry.register(skill);
  return registry;
}

function makeSkill(
  name: string,
  source: SkillSource,
  description = 'desc',
  skillPath?: string,
): SkillDefinition {
  const finalPath = skillPath ?? `/tmp/${source}/${name}/SKILL.md`;
  return {
    name,
    description,
    path: finalPath,
    dir: finalPath.replace(/\/SKILL\.md$/, ''),
    content: '',
    metadata: { type: 'prompt' },
    source,
  };
}

function sectionFor(rendered: string, header: string): string {
  const start = rendered.indexOf(header);
  if (start === -1) return '';
  const next = rendered.indexOf('### ', start + header.length);
  return next === -1 ? rendered.slice(start) : rendered.slice(start, next);
}
