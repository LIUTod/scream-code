import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'pathe';

export function resolveScreamHome(homeDir?: string | undefined): string {
  return homeDir ?? process.env['SCREAM_CODE_HOME'] ?? join(homedir(), '.scream-code');
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
