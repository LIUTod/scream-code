import { dirname, join, normalize } from 'pathe';

import type { Jian } from '@scream-code/jian';

import { ErrorCodes, ScreamError } from '#/errors';
import { z } from 'zod';
import { resolveSkillInstallPaths } from '#/skill/install-paths';
import { isSafeRelativePath } from '#/utils/path-safety';

export interface SkillPackageFile {
  /** Relative path inside the skill directory (e.g. `script.sh`). */
  readonly path: string;
  readonly content: string;
}

export interface SkillPackage {
  /** Directory-safe skill name in kebab-case. */
  readonly name: string;
  readonly description: string;
  /** Full SKILL.md content, including YAML frontmatter. */
  readonly content: string;
  /** Optional supporting files. */
  readonly files: readonly SkillPackageFile[];
}

export type SkillInstallScope = 'user' | 'project';
export const SKILL_TYPE_SCHEMA = z.enum([
  'workflow',
  'code-pattern',
  'troubleshooting',
  'tool-chain',
  'custom',
]);

const SKILL_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Convert an arbitrary proposed skill name into a kebab-case directory name.
 * Throws if the result would be empty or unsafe.
 */
export function sanitizeSkillName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const slug = trimmed
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  if (slug.length === 0 || !SKILL_NAME_REGEX.test(slug)) {
    throw new ScreamError(
      ErrorCodes.REQUEST_INVALID,
      `Invalid skill name "${name}". Use lowercase letters, numbers, and hyphens only.`,
    );
  }
  return slug;
}

/**
 * Return true if `path` already exists (file or directory).
 */
async function pathExists(jian: Jian, path: string): Promise<boolean> {
  try {
    await jian.iterdir(path).next();
    return true;
  } catch {
    return false;
  }
}

export interface WriteSkillPackageOptions {
  readonly jian: Jian;
  readonly package: SkillPackage;
  readonly scope: SkillInstallScope;
  readonly userHomeDir: string;
  readonly workDir: string;
}

export interface WriteSkillPackageResult {
  readonly targetDir: string;
}

/**
 * Write a skill package to the user or project skill directory.
 *
 * Throws `ScreamError` with `skill.already_exists` if the target directory
 * already exists. Supporting files are written relative to the skill directory;
 * any path-traversal attempt is rejected.
 */
export async function writeSkillPackage(
  options: WriteSkillPackageOptions,
): Promise<WriteSkillPackageResult> {
  const { jian, package: pkg, scope, userHomeDir, workDir } = options;
  const name = sanitizeSkillName(pkg.name);

  const paths = await resolveSkillInstallPaths({ userHomeDir, workDir });
  const baseDir = scope === 'user' ? paths.userDir : paths.projectDir;
  const targetDir = join(baseDir, name);

  if (await pathExists(jian, targetDir)) {
    throw new ScreamError(
      ErrorCodes.SKILL_ALREADY_EXISTS,
      `Skill "${name}" already exists at ${targetDir}. Choose a different name or delete the existing skill first.`,
    );
  }

  try {
    await jian.mkdir(targetDir, { parents: true, existOk: false });
  } catch (error) {
    if (error instanceof ScreamError) throw error;
    throw new ScreamError(
      ErrorCodes.SKILL_INSTALL_FAILED,
      `Failed to create skill directory ${targetDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    await jian.writeText(join(targetDir, 'SKILL.md'), pkg.content, { mode: 'w' });

    for (const file of pkg.files) {
      if (!isSafeRelativePath(file.path)) {
        throw new ScreamError(
          ErrorCodes.REQUEST_INVALID,
          `Unsafe supporting file path "${file.path}". Paths must be relative and cannot escape the skill directory.`,
        );
      }
      const filePath = join(targetDir, normalize(file.path));
      const fileDir = dirname(filePath);
      if (fileDir !== targetDir) {
        await jian.mkdir(fileDir, { parents: true, existOk: true });
      }
      await jian.writeText(filePath, file.content, { mode: 'w' });
    }
  } catch (error) {
    if (error instanceof ScreamError) throw error;
    throw new ScreamError(
      ErrorCodes.SKILL_INSTALL_FAILED,
      `Failed to write skill files to ${targetDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { targetDir };
}

