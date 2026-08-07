import type { SlashCommand } from '@liutod-scream/pi-tui';
import type { FlagId } from '@scream-code/scream-code-sdk';

export type SlashCommandAvailability = 'always' | 'idle-only';

export interface ScreamSlashCommand<Name extends string = string> extends SlashCommand {
  readonly name: Name;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly priority?: number;
  readonly availability?: SlashCommandAvailability | ((args: string) => SlashCommandAvailability);
  /** When set, the command is hidden from the palette and blocked unless this flag is enabled. */
  readonly experimentalFlag?: FlagId;
  /**
   * Argument hint shown in the autocomplete dropdown for `/command ` (without
   * leading slash). Maps to pi-tui's `AutocompleteItem.argumentHint`.
   */
  readonly argumentHint?: string;
  /** Skill origin when this command was registered from a skill. */
  readonly source?: 'project' | 'user' | 'extra' | 'builtin';
}

export interface ParsedSlashInput {
  readonly name: string;
  readonly args: string;
}

export type SlashCommandBusyReason = 'streaming' | 'compacting';

export type SlashCommandInvalidReason = 'unknown';
