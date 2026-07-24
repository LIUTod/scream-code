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
   * Ghost-text hint shown after `/command ` (without leading slash).
   * Maps to pi-tui's `SlashCommand.argumentHint` -> `Editor.setArgumentHints`.
   */
  readonly argumentHint?: string;
}

export interface ParsedSlashInput {
  readonly name: string;
  readonly args: string;
}

export type SlashCommandBusyReason = 'streaming' | 'compacting';

export type SlashCommandInvalidReason = 'unknown';
