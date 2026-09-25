/**
 * External-editor helper — spawn $VISUAL / $EDITOR (or a configured
 * command) on a temp file seeded with the current editor buffer, then
 * read the edited contents back.
 *
 * Resolution priority:
 *   configured (from Core/SDK defaults or `/editor`) >
 *   $VISUAL > $EDITOR > undefined (caller handles "no editor" toast).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function resolveEditorCommand(configured?: string | null): string | undefined {
  const candidates = [configured, process.env['VISUAL'], process.env['EDITOR']];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) {
      return c.trim();
    }
  }
  return undefined;
}

/**
 * Launch `command` (tokenised by the platform's command interpreter) against
 * a temp file seeded with `initialText`. Returns the edited contents on
 * success, or `undefined` if the editor exited non-zero / the file
 * disappeared.
 *
 * The command may carry argv-style arguments (`"code --wait"`,
 * `"nvim +set ft=markdown"`), so it is handed to the interpreter the host
 * platform actually has: `/bin/sh -c` on POSIX, `cmd.exe /d /s /c` on
 * Windows. The two disagree on quoting, so each branch carries its own
 * escaping rather than borrowing the other's. `platform` is injectable so
 * both branches stay testable off their native host.
 */
export async function editInExternalEditor(
  initialText: string,
  command: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'scream-edit-'));
  const file = join(dir, 'prompt.md');
  await writeFile(file, initialText, 'utf-8');
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const child =
        platform === 'win32'
          ? spawn(windowsCommandShell(), ['/d', '/s', '/c', `"${command} ${cmdQuote(file)}"`], {
              stdio: 'inherit',
              windowsVerbatimArguments: true,
            })
          : spawn('/bin/sh', ['-c', `${command} ${shellQuote(file)}`], { stdio: 'inherit' });
      child.on('exit', (c) =>{  resolve(c ?? 0); });
      child.on('error', reject);
    });
    if (code !== 0) return undefined;
    return await readFile(file, 'utf-8');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // best-effort cleanup
    });
  }
}

/** The interpreter `cmd.exe`-style command lines run through, as Node's own
 * `shell: true` resolves it on Windows. */
function windowsCommandShell(): string {
  const comspec = process.env['ComSpec'];
  return comspec !== undefined && comspec.trim().length > 0 ? comspec : 'cmd.exe';
}

function shellQuote(path: string): string {
  // Single-quote and escape any embedded single quotes.
  return `'${path.replaceAll('\'', "'\\''")}'`;
}

function cmdQuote(path: string): string {
  // Double quotes, the only quoting `cmd.exe` understands. The path is one
  // this module just created, so a space in the temp root is the realistic
  // case; an embedded quote (which a temp path cannot normally hold) is
  // doubled, matching how the platform's C runtime parses argv.
  return `"${path.replaceAll('"', '""')}"`;
}
