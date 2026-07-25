import type { SkillRegistry } from '../registry';
import { DREAM_SKILL } from './dream';
import { MAKE_SKILL_SKILL } from './make-skill';

export function registerBuiltinSkills(registry: SkillRegistry): void {
  registry.registerBuiltinSkill(DREAM_SKILL);
  registry.registerBuiltinSkill(MAKE_SKILL_SKILL);
}

export { DREAM_SKILL, MAKE_SKILL_SKILL };
