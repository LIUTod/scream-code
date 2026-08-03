import type { Session, SkillSummary } from '@scream-code/scream-code-sdk';

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

export function buildSkillSlashCommands(
  skills: readonly SkillSummary[],
  builtinCommandNames?: ReadonlySet<string>,
): SkillSlashCommands {
  const commandMap = new Map<string, string>();
  const commands: ScreamSlashCommand[] = [];
  const reservedNames = builtinCommandNames ?? new Set<string>();

  for (const skill of skills) {
    if (!isUserActivatableSkill(skill)) continue;

    const commandName = `skill:${skill.name}`;
    commandMap.set(commandName, skill.name);

    commands.push({
      name: commandName,
      aliases: [],
      description: skill.description ?? '',
      source: skill.source,
    });

    // Also register the bare name so built-in skills like /dream
    // appear in autocomplete. Skip names that collide with built-in
    // slash commands (e.g. /make-skill) to avoid duplicate entries.
    // The `skill:` prefixed entries above are filtered by autocomplete to
    // hide builtin skills only; user/project skills stay discoverable.
    if (skill.source === 'builtin' && !reservedNames.has(skill.name)) {
      commandMap.set(skill.name, skill.name);
      commands.push({
        name: skill.name,
        aliases: [],
        description: skill.description ?? '',
        source: skill.source,
      });
    }
  }
  return { commands, commandMap };
}
