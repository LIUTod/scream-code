import { dirname, join, normalize } from 'pathe';

import type { Jian } from '@scream-code/jian';

import { ErrorCodes, ScreamError } from '#/errors';
import { PluginManager } from '#/plugin/manager';

import { sanitizeSkillName, type SkillPackage } from './skill-package-writer';

export interface WritePluginSkillPackageOptions {
  readonly jian: Jian;
  readonly screamHomeDir: string;
  readonly package: SkillPackage;
  /**
   * The process-wide plugin table. When provided, the generated plugin is
   * registered on it directly. When omitted, a private PluginManager is built
   * for this call only (standalone/test use).
   */
  readonly manager?: PluginManager;
}

export interface WritePluginSkillPackageResult {
  readonly targetDir: string;
  /** Plugin-center id assigned by registerGenerated (needed for hot-apply). */
  readonly pluginId: string;
}

const MANIFEST_FILE = 'scream.plugin.json';

function isSafeRelativePath(filePath: string): boolean {
  const normalized = normalize(filePath);
  if (normalized.startsWith('..')) return false;
  if (normalize('/' + normalized).startsWith('..')) return false;
  return !normalized.startsWith('/');
}

export async function writePluginSkillPackage(
  options: WritePluginSkillPackageOptions,
): Promise<WritePluginSkillPackageResult> {
  const { jian, screamHomeDir, manager, package: pkg } = options;
  const name = sanitizeSkillName(pkg.name);
  const targetDir = join(screamHomeDir, 'plugins', 'managed', name);

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
    const manifest = {
      name,
      version: '0.1.0',
      description: pkg.description,
      skills: ['./'],
    };
    await jian.writeText(join(targetDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 'w' });
    await jian.writeText(join(targetDir, 'SKILL.md'), pkg.content, { mode: 'w' });
    const files = pkg.files ?? [];
    for (const file of files) {
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

  let registered;
  try {
    if (manager !== undefined) {
      registered = await manager.registerGenerated(targetDir);
    } else {
      // No shared table was injected, so build a throwaway manager that only
      // writes this entry to disk. Callers that own a live PluginManager must
      // pass it in: two managers over installed.json clobber each other's
      // whole table, and the live one would never learn about this plugin.
      const owned = new PluginManager({ screamHomeDir });
      await owned.load();
      registered = await owned.registerGenerated(targetDir);
    }
  } catch (error) {
    throw new ScreamError(
      ErrorCodes.SKILL_INSTALL_FAILED,
      `Failed to register skill in plugin center: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { targetDir, pluginId: registered.id };
}

async function pathExists(jian: Jian, filePath: string): Promise<boolean> {
  try {
    await jian.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
