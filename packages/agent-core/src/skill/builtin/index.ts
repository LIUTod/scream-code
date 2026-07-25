import type { SkillRegistry } from '../registry';
import { DREAM_SKILL } from './dream';
import { MAKE_SKILL_SKILL } from './make-skill';
import { TOOL_PROMPT_OPTIMIZATION_SKILL } from './tool-prompt-optimization';

export function registerBuiltinSkills(registry: SkillRegistry): void {
  registry.registerBuiltinSkill(DREAM_SKILL);
  registry.registerBuiltinSkill(MAKE_SKILL_SKILL);
  registry.registerBuiltinSkill(TOOL_PROMPT_OPTIMIZATION_SKILL);
}

export { DREAM_SKILL, MAKE_SKILL_SKILL, TOOL_PROMPT_OPTIMIZATION_SKILL };
