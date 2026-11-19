/**
 * Startup hint for users who moved their Scream home with `SCREAM_CODE_HOME`.
 *
 * The user's own skills (`skills/`) and instructions (`AGENTS.md`) live in the
 * Scream home and move with it. Older builds kept them in `~/.scream-code`
 * whatever the variable said, so someone who set it may still have them
 * there: they are no longer loaded. Say so, and where to move them, instead
 * of letting them silently disappear. The hint stops as soon as the new
 * location exists (moving the files, or creating an empty directory, ends it),
 * and a given hint is said once per home (`legacyUserAssetsNoticeOnce`): a
 * different one — something new left behind — is said again.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { t } from '@scream-code/config';

function canonical(path: string): string {
  let resolved = resolve(path);
  try {
    // Real path: macOS volumes are case-insensitive by default and either
    // side may be a symlink; the native call reports the on-disk spelling.
    resolved = realpathSync.native(resolved);
  } catch {
    // Missing directory: compare the plain resolved path.
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function hasEntries(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => !name.startsWith('.'));
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The hint text, or `undefined` when there is nothing left behind. */
export function legacyUserAssetsNotice(screamHome: string, osHome: string = homedir()): string | undefined {
  const legacyHome = join(osHome, '.scream-code');
  if (canonical(legacyHome) === canonical(screamHome)) return undefined;

  const items: string[] = [];
  if (hasEntries(join(legacyHome, 'skills')) && !existsSync(join(screamHome, 'skills'))) {
    items.push(join(legacyHome, 'skills'));
  }
  if (isFile(join(legacyHome, 'AGENTS.md')) && !existsSync(join(screamHome, 'AGENTS.md'))) {
    items.push(join(legacyHome, 'AGENTS.md'));
  }
  if (items.length === 0) return undefined;
  return t('startup.legacy_user_assets', { items: items.join(', '), home: screamHome });
}

/**
 * {@link legacyUserAssetsNotice}, said once per Scream home: someone who keeps
 * a second profile on purpose should not hear it at every start. A marker in
 * the home's `run/` remembers that it was said.
 */
export function legacyUserAssetsNoticeOnce(screamHome: string, osHome: string = homedir()): string | undefined {
  const notice = legacyUserAssetsNotice(screamHome, osHome);
  if (notice === undefined) return undefined;
  const marker = join(screamHome, 'run', 'legacy-assets-noticed');
  try {
    if (readFileSync(marker, 'utf8') === notice) return undefined;
  } catch {
    // Not said yet.
  }
  return notice;
}

/** Remember that `notice` was shown (call once the person has seen it). */
export function markLegacyUserAssetsNoticed(screamHome: string, notice: string): void {
  try {
    mkdirSync(join(screamHome, 'run'), { recursive: true });
    writeFileSync(join(screamHome, 'run', 'legacy-assets-noticed'), notice, 'utf8');
  } catch {
    // Not remembered: it is said again next time, which is harmless.
  }
}

