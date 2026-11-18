import { z } from 'zod';

import { ErrorCodes, ScreamError } from '#/errors';

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
