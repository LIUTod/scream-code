import type { SkillRegistry } from '../registry';
import { DREAM_SKILL } from './dream';
import { IMAGE_SKILL } from './image';
import { MAKE_SKILL_SKILL } from './make-skill';

export function registerBuiltinSkills(registry: SkillRegistry): void {
  registry.registerBuiltinSkill(DREAM_SKILL);
  registry.registerBuiltinSkill(IMAGE_SKILL);
  registry.registerBuiltinSkill(MAKE_SKILL_SKILL);
}

export { DREAM_SKILL, IMAGE_SKILL, MAKE_SKILL_SKILL };
