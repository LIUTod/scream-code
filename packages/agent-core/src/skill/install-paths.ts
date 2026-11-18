import { basename, dirname, join, normalize } from 'pathe';

import { findProjectRoot, userSkillsDir } from './scanner';

export interface SkillInstallPaths {
  /** <scream home>/skills (`~/.scream-code/skills` by default) */
  readonly userDir: string;
  /** <projectRoot>/.scream-code/skills */
  readonly projectDir: string;
}

const MANAGED_SKILL_ROOT_NAMES = new Set(['.scream-code', '.agents']);

/**
 * Given a skill path, return the filesystem entry that represents the whole
 * skill installation unit. For directory-based skills this is the skill's root
 * directory (so bundled sub-skills are removed together); for flat `.md`
 * skills this is the `.md` file itself.
 *
 * The install unit is the first ancestor of `skillPath` whose parent is a
 * managed skill root: one of `skillRoots` (the user's skill directory, which
 * follows SCREAM_CODE_HOME and may have any name), or a directory shaped like
 * `<...>/.scream-code/skills` or `<...>/.agents/skills`.
 */
export function resolveSkillInstallUnit(skillPath: string, skillRoots: readonly string[] = []): string {
  const normalized = normalize(skillPath).replaceAll('\\', '/');
  for (const root of skillRoots) {
    const base = normalize(root).replaceAll('\\', '/').replace(/\/+$/, '');
    const prefix = `${base}/`;
    if (!samePathPrefix(normalized, prefix)) continue;
    const first = normalized.slice(prefix.length).split('/')[0];
    if (first !== undefined && first.length > 0) return normalized.slice(0, prefix.length) + first;
  }
  let current = normalized;
  while (true) {
    const parent = dirname(current).replaceAll('\\', '/');
    if (parent === current || parent === '.') {
      throw new Error(`Skill path "${skillPath}" is not under a managed skill root`);
    }
    const parentBase = basename(parent);
    const grandparent = dirname(parent).replaceAll('\\', '/');
    const grandparentBase = grandparent === '.' ? '' : basename(grandparent);
    if (parentBase === 'skills' && MANAGED_SKILL_ROOT_NAMES.has(grandparentBase)) {
      return current;
    }
    current = parent;
  }
}

/** Windows paths are case-insensitive; elsewhere compare exactly. */
function samePathPrefix(path: string, prefix: string): boolean {
  return process.platform === 'win32'
    ? path.toLowerCase().startsWith(prefix.toLowerCase())
    : path.startsWith(prefix);
}

/**
 * Resolve the two standard skill installation directories.
 *
 * - User skills live under `<scream home>/skills` (`~/.scream-code/skills`
 *   unless SCREAM_CODE_HOME moves it).
 * - Project skills live under `<git-root>/.scream-code/skills`, where the
 *   git-root is the nearest ancestor of `workDir` containing a `.git` directory
 *   (falling back to `workDir` itself).
 */
export async function resolveSkillInstallPaths(options: {
  readonly userHomeDir: string;
  readonly screamHomeDir?: string | undefined;
  readonly workDir: string;
}): Promise<SkillInstallPaths> {
  const projectRoot = await findProjectRoot(options.workDir);
  return {
    userDir: userSkillsDir(options),
    projectDir: join(projectRoot, '.scream-code', 'skills'),
  };
}
