import type { SkillRegistry } from '../registry';
import { MCP_CONFIG_SKILL } from './mcp-config';

export function registerBuiltinSkills(registry: SkillRegistry): void {
  registry.registerBuiltinSkill(MCP_CONFIG_SKILL);
}

export { MCP_CONFIG_SKILL };
