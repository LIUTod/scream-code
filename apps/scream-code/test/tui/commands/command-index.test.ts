import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUILTIN_SLASH_COMMANDS } from '#/tui/commands/registry';

const REPO_ROOT = join(import.meta.dirname, '../../../../..');
const SYSTEM_MD = join(REPO_ROOT, 'packages/agent-core/src/profile/default/system.md');

/** `/name` tokens listed inside the prompt's "Product Command Index" section. */
function indexedCommands(): Set<string> {
  const md = readFileSync(SYSTEM_MD, 'utf8');
  const start = md.indexOf('# Product Command Index');
  const end = md.indexOf('# CONTRACT', start);
  if (start === -1 || end === -1) {
    throw new Error('Product Command Index section is missing from system.md');
  }
  const block = md.slice(start, end);
  return new Set([...block.matchAll(/`\/([a-z0-9-]+)`/g)].map((match) => match[1] as string));
}

describe('product command index in the system prompt', () => {
  // `/dream` is the bare name a built-in skill registers at runtime
  // (see commands/skills.ts), so it has no entry in the static registry.
  // `/skill` is the prefix entry — the real commands are `/skill:<name>`.
  const RUNTIME_ONLY_NAMES = new Set(['dream', 'skill']);

  it('lists every command name the TUI registers', () => {
    const indexed = indexedCommands();
    const missing = BUILTIN_SLASH_COMMANDS.map((command) => command.name).filter(
      (name) => !indexed.has(name),
    );

    expect(missing).toEqual([]);
  });

  it('does not advertise commands that no longer exist', () => {
    const known = new Set<string>(
      BUILTIN_SLASH_COMMANDS.flatMap((command) => [
        command.name as string,
        ...(command.aliases as readonly string[]),
      ]),
    );
    const stale = [...indexedCommands()].filter(
      (name) => !known.has(name) && !RUNTIME_ONLY_NAMES.has(name),
    );

    expect(stale).toEqual([]);
  });
});
