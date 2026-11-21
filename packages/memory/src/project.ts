import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

/**
 * Trailing separators (and, on Windows, case) make `/a/b/` and `C:\A\B` compare
 * differently from their twins; normalise once for every comparison below.
 */
function normalizeDir(dir: string): string {
  const slashed = dir.replaceAll('\\', '/').replace(/\/+$/u, '');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * Whether a memo stamped with `memoDir` belongs to the project at `projectDir`:
 * the same folder, one inside the other (a session started in a subfolder of the
 * repo), or a memo not tied to any project — no folder, or the home folder a
 * session was started in.
 */
export function isSameProjectDir(memoDir: string, projectDir: string, home: string = homedir()): boolean {
  if (memoDir === '') return true;
  const memo = normalizeDir(memoDir);
  if (memo === normalizeDir(home)) return true;
  const project = normalizeDir(projectDir);
  return memo === project || project.startsWith(`${memo}/`) || memo.startsWith(`${project}/`);
}

/**
 * Cache of directory → project root. Recall runs on every prompt, and walking
 * the filesystem up to the git root each time is pointless work: a session's cwd
 * and its checkout do not move. A repository created mid-session is not noticed
 * until the process restarts, which is the right trade for a per-prompt path.
 */
const rootCache = new Map<string, string | undefined>();

/**
 * The project a directory belongs to: the git working-tree root above it.
 *
 * `undefined` means "no project" in two cases, both deliberate:
 * - the directory is not inside a checkout, so there is nothing to scope to;
 * - walking up reaches the home directory first. Starting `scream` in `$HOME` is
 *   not a project, and stamping the home directory as one — which is what
 *   `projectDir = cwd` did — made 84 of 87 memos in a real library claim the same
 *   "project", quietly switching the cross-project guard off.
 */
export function resolveProjectRoot(cwd: string, home: string = homedir()): string | undefined {
  const key = resolve(cwd);
  if (rootCache.has(key)) return rootCache.get(key);

  const homeDir = normalizeDir(home);
  const { root } = parse(key);
  let dir = key;
  let found: string | undefined;
  for (;;) {
    // Home is the boundary: a checkout above it would be someone else's project,
    // and a dotfiles repo *in* home must not make every session a project.
    if (normalizeDir(dir) === homeDir) break;
    if (existsSync(join(dir, '.git'))) {
      found = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }
  rootCache.set(key, found);
  return found;
}

/**
 * Stamp a memo's origin: the directory the session ran in, and the project that
 * directory belongs to.
 *
 * One call sets both so no write path can record the first without the second —
 * forgetting the project half is what made the scoping useless in the first
 * place.
 */
export function stampProject(
  memo: { projectDir: string; projectRoot?: string | undefined },
  cwd: string,
): void {
  memo.projectDir = cwd;
  memo.projectRoot = resolveProjectRoot(cwd);
}

/**
 * Whether a memo belongs to the project a session runs in.
 *
 * The project root decides when both sides know it — that is the real answer.
 * Otherwise this falls back to the directory comparison (a memo written before
 * roots were recorded), where an empty or home directory still counts as
 * "unknown project, keep it" so legacy memos stay reachable.
 */
export function isSameProject(
  memo: { readonly projectRoot?: string | undefined; readonly projectDir: string },
  current: { readonly projectRoot?: string | undefined; readonly projectDir: string },
  home: string = homedir(),
): boolean {
  if (memo.projectRoot !== undefined && current.projectRoot !== undefined) {
    return normalizeDir(memo.projectRoot) === normalizeDir(current.projectRoot);
  }
  return isSameProjectDir(memo.projectDir, current.projectDir, home);
}
