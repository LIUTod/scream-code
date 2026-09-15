import { afterEach, describe, expect, it } from 'vitest';

import {
  filterSlashCommands,
  isAdvancedCollapsed,
  isSlashSkillName,
  resetSlashMenuFilter,
  resolveCommandName,
  setSlashMenuFilter,
  setSlashSkills,
  slashHelpText,
  SLASH_COMMANDS,
} from '../../src/web/frontend/src/commands';

/**
 * Slash catalogue merge and filtering semantics: command groups (core always
 * listed / advanced folded away on an empty query) + skill group + the in-menu
 * secondary filter. Pure-function tests, no DOM.
 */

afterEach(() => {
  setSlashSkills([]);
  resetSlashMenuFilter();
});

describe('filterSlashCommands — command groups', () => {
  it('an empty query lists only core commands; the advanced group collapses while /bot stays in the catalogue', () => {
    const list = filterSlashCommands('');
    expect(list.every((c) => c.group !== 'advanced')).toBe(true);
    expect(list.map((c) => c.name)).toEqual(
      expect.arrayContaining(['model', 'new', 'clear', 'help', 'compact', 'title', 'btw']),
    );
    expect(list.map((c) => c.name)).not.toContain('bot');
    expect(isAdvancedCollapsed()).toBe(true);
  });

  it('a matching query expands the advanced group (bot/yes become reachable again)', () => {
    const names = filterSlashCommands('bo').map((c) => c.name);
    expect(names).toContain('bot');
    expect(isAdvancedCollapsed()).toBe(false);
    const yesNames = filterSlashCommands('yolo').map((c) => c.name);
    expect(yesNames).toContain('yes');
  });

  it('every command carries a group, and the /help text covers all commands (including bot)', () => {
    expect(SLASH_COMMANDS.every((c) => c.group === 'core' || c.group === 'advanced')).toBe(true);
    const help = slashHelpText();
    for (const c of SLASH_COMMANDS) expect(help).toContain(`/${c.name}`);
  });
});

describe('filterSlashCommands — skill merge', () => {
  it('skills follow the commands, carry kind/source, and select as text (acceptsInput)', () => {
    setSlashSkills([
      { name: 'web-clone', description: '复刻网站', source: 'user' },
      { name: 'push', description: '发布确认门', pluginId: 'managed' },
    ]);
    const list = filterSlashCommands('');
    const firstSkill = list.findIndex((c) => c.kind === 'skill');
    expect(firstSkill).toBeGreaterThan(-1);
    // The command block as a whole precedes the skill block.
    expect(list.slice(0, firstSkill).every((c) => c.kind !== 'skill')).toBe(true);
    const skill = list[firstSkill]!;
    expect(skill.name).toBe('web-clone');
    expect(skill.description).toBe('复刻网站');
    expect(skill.acceptsInput).toBe(true);
    expect(skill.source).toBe('user');
    const pluginSkill = list.find((c) => c.name === 'push')!;
    expect(pluginSkill.source).toBe('plugin:managed');
  });

  it('queries match skills by name prefix or description substring; unknown-command resolution leaves skill names alone', () => {
    setSlashSkills([
      { name: 'data-review', description: '审核数据面板', source: 'project' },
      { name: 'humanizer', description: '去除 AI 腔', source: 'user' },
    ]);
    expect(filterSlashCommands('data').map((c) => c.name)).toContain('data-review');
    expect(filterSlashCommands('面板').map((c) => c.name)).toContain('data-review');
    expect(filterSlashCommands('zzz')).toHaveLength(0);
    // A skill name is never mistaken for a command alias by resolveCommandName.
    expect(resolveCommandName('data-review')).toBe('data-review');
    expect(isSlashSkillName('Data-Review')).toBe(true);
    expect(isSlashSkillName('nope')).toBe(false);
  });
});

describe('setSlashMenuFilter — in-menu secondary filter', () => {
  it('combines with the slash suffix as an AND to narrow the candidates', () => {
    setSlashSkills([{ name: 'compact-notes', description: '整理笔记', source: 'user' }]);
    const all = filterSlashCommands('co');
    expect(all.map((c) => c.name)).toEqual(expect.arrayContaining(['compact', 'compact-notes']));
    setSlashMenuFilter('notes');
    const narrowed = filterSlashCommands('co').map((c) => c.name);
    expect(narrowed).toEqual(['compact-notes']);
    resetSlashMenuFilter();
    expect(filterSlashCommands('co').length).toBeGreaterThan(1);
  });
});
