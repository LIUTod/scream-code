import type { Session, SkillSummary } from '@scream-cli/scream-code-sdk';

import type { ScreamSlashCommand } from './types';

export type SkillListSession = Pick<Session, 'listSkills'>;

export interface SkillSlashCommands {
  readonly commands: readonly ScreamSlashCommand[];
  readonly commandMap: ReadonlyMap<string, string>;
}

export function isUserActivatableSkill(skill: SkillSummary): boolean {
  return (
    skill.type === undefined ||
    skill.type === 'prompt' ||
    skill.type === 'inline' ||
    skill.type === 'flow'
  );
}

export function buildSkillSlashCommands(skills: readonly SkillSummary[]): SkillSlashCommands {
  const commandMap = new Map<string, string>();
  const commands = skills.filter(isUserActivatableSkill).map((skill) => {
    const commandName = `skill:${skill.name}`;
    commandMap.set(commandName, skill.name);
    return {
      name: commandName,
      aliases: [],
      description: skill.description ?? '',
    };
  });
  return { commands, commandMap };
}
