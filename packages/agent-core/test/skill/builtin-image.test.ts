import { describe, expect, it } from 'vitest';

import { registerBuiltinSkills, IMAGE_SKILL, DREAM_SKILL } from '../../src/skill/builtin';
import { SkillRegistry } from '../../src/skill';

describe('built-in image skill', () => {
  it('parses with the canonical name, inline type, and trigger-rich description', () => {
    expect(IMAGE_SKILL.name).toBe('image');
    expect(IMAGE_SKILL.source).toBe('builtin');
    expect(IMAGE_SKILL.metadata.type).toBe('inline');
    expect(IMAGE_SKILL.path).toBe('builtin://image');

    const description = IMAGE_SKILL.description;
    for (const trigger of ['画', '生成图', '图生图', '改图']) {
      expect(description).toContain(trigger);
    }
  });

  it('stays model-invocable, unlike dream which is slash-only', () => {
    expect(IMAGE_SKILL.metadata.disableModelInvocation).not.toBe(true);
    expect(DREAM_SKILL.metadata.disableModelInvocation).toBe(true);
  });

  it('registers into a fresh registry and appears in the model-invocable list', () => {
    const registry = new SkillRegistry();
    registerBuiltinSkills(registry);

    const names = registry.listSkills().map((skill) => skill.name);
    expect(names).toContain('image');
    expect(names).toContain('dream');

    const invocable = registry.listInvocableSkills().map((skill) => skill.name);
    expect(invocable).toContain('image');
    expect(invocable).not.toContain('dream');
  });

  it('body directs unconfigured users to /config image and forbids key handling in chat', () => {
    expect(IMAGE_SKILL.content).toContain('/config image');
    expect(IMAGE_SKILL.content).toContain('ImageGenerate');
    expect(IMAGE_SKILL.content).not.toMatch(/api[_-]?key\s*[:=]\s*\S+/i);
  });
});
