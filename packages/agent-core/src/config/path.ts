import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'pathe';

/**
 * The Scream home directory: an explicit `homeDir` (SDK callers, tests), else
 * `SCREAM_CODE_HOME`, else `~/.scream-code`. Everything Scream keeps for the
 * user lives here — config, sessions, memory, plugins, the user's own skills
 * (`skills/`) and instructions (`AGENTS.md`) — so setting the variable moves
 * all of it, and a second value gives a fully separate profile.
 */
export function resolveScreamHome(homeDir?: string | undefined): string {
  return homeDir ?? screamHomeFromEnv(process.env['SCREAM_CODE_HOME']) ?? join(homedir(), '.scream-code');
}

/**
 * `SCREAM_CODE_HOME` as users actually set it, on every platform: blank means
 * unset (an empty value is how many people "clear" a variable); one pair of
 * surrounding quotes is dropped (`set SCREAM_CODE_HOME="D:\Scream"` in cmd
 * keeps them in the value); a leading `~` is the user's home, because values
 * that do not pass through a shell (Windows environment settings, launchd,
 * systemd, IDE run configs) are never expanded; a relative path is made
 * absolute, so every part of the process agrees on one directory.
 */
export function screamHomeFromEnv(value: string | undefined): string | undefined {
  let text = value?.trim() ?? '';
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0]) {
    text = text.slice(1, -1).trim();
  }
  if (text.length === 0) return undefined;
  if (text === '~') return resolve(homedir());
  if (text.startsWith('~/') || text.startsWith('~\\')) return resolve(homedir(), text.slice(2));
  return resolve(text);
}

export function resolveConfigPath(input: {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}): string {
  return input.configPath ?? join(resolveScreamHome(input.homeDir), 'config.toml');
}

export function ensureScreamHome(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
}
