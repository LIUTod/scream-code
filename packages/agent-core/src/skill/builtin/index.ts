import type { SkillRegistry } from '../registry';
import { DREAM_SKILL } from './dream';

export function registerBuiltinSkills(registry: SkillRegistry): void {
  registry.registerBuiltinSkill(DREAM_SKILL);
}

export { DREAM_SKILL };
