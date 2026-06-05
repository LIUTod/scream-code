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
  const commands: ScreamSlashCommand[] = [];
  for (const skill of skills) {
    if (!isUserActivatableSkill(skill)) continue;

    const commandName = `skill:${skill.name}`;
    commandMap.set(commandName, skill.name);

    commands.push({
      name: commandName,
      aliases: [],
      description: skill.description ?? '',
    });

    // Also register the bare name so built-in skills like /dream
    // appear in autocomplete. The `skill:` prefixed entries above
    // are still filtered out by setupAutocomplete() to avoid
    // cluttering the dropdown with ~40 entries.
    if (skill.source === 'builtin') {
      commandMap.set(skill.name, skill.name);
      commands.push({
        name: skill.name,
        aliases: [],
        description: skill.description ?? '',
      });
    }
  }
  return { commands, commandMap };
}
