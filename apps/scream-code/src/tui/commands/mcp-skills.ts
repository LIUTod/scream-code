/**
 * chrome-devtools-mcp 随包分发的官方 Agent-Skills 安装器。
 *
 * `/mcp` 面板用它在用户 skills 目录里「安装 / 更新上游 Skill」，以及「移除上游
 * Skill」。上游包躺在 npx 缓存里（`<_npx>/<hash>/node_modules/chrome-devtools-mcp`），
 * 版本随时会变，所以安装状态记在一份 manifest 里：manifest 既是版本戳，也是
 * **所有权凭据**——只有 manifest 里列出的目录名才允许我们覆盖或删除。
 *
 * 所有读取路径都保持「不抛异常」：面板刷新时包可能还没下载、manifest 可能被手改。
 * 写路径（cp / writeFile）的失败则原样抛出，交给调用方提示用户。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const UPSTREAM_SKILL_SOURCE = 'chrome-devtools-mcp';
export const SKILLS_MANIFEST_NAME = '.chrome-devtools-skills.json';

export interface UpstreamSkillsManifest {
  source: string;
  version: string;
  installedAt: string;
  skills: string[];
}

export interface PackageSkillsLocation {
  dir: string;
  version: string;
}

export interface SkillInstallPlan {
  /** Skill dirs to copy (source + target). */
  copy: Array<{ name: string; from: string; to: string }>;
  /** Skill dirs left alone because a foreign (non-owned) directory already uses the name. */
  conflicts: string[];
  /** Directory names present upstream but already installed at this version. */
  upToDate: string[];
}

export interface SkillInstallResult {
  installed: string[];
  conflicts: string[];
  upToDate: string[];
  manifest: UpstreamSkillsManifest;
}

// ─── 版本与目录基础件 ─────────────────────────────────────────────────

/** 纯数字点号比较；预发布后缀（`1.14.0-beta.1`）按契约忽略。 */
function versionParts(version: string): number[] {
  const core = version.split('-')[0] ?? '';
  return core.split('.').map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isNaN(value) ? 0 : value;
  });
}

function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * manifest 里的名字直接拼进文件路径，因此只接受单层目录名。
 * 手工改坏的 manifest 不能让删除逻辑跑到 skills 根目录之外。
 */
function isPlainDirName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\')
  );
}

function readPackageVersion(pkgDir: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const version = (parsed as Record<string, unknown>)['version'];
    return typeof version === 'string' && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

// ─── 上游包定位 ──────────────────────────────────────────────────────

/**
 * 扫描 `<npmCacheRoot>/_npx/<hash>/node_modules/chrome-devtools-mcp`，取版本最高的一份。
 * 同一个包会被多次 npx 安装并存，旧版本目录从不清理，所以必须比较而不是取第一个。
 */
export function findPackageSkillsLocation(
  npmCacheRoot: string,
): PackageSkillsLocation | undefined {
  const npxRoot = join(npmCacheRoot, '_npx');
  let entries: string[];
  try {
    entries = readdirSync(npxRoot, { encoding: 'utf8' });
  } catch {
    // 没跑过 npx（缓存目录不存在）是常态，不是错误。
    return undefined;
  }

  let best: PackageSkillsLocation | undefined;
  for (const hash of entries) {
    const dir = join(npxRoot, hash, 'node_modules', UPSTREAM_SKILL_SOURCE);
    const version = readPackageVersion(dir);
    if (version === undefined) continue;
    if (best === undefined || compareVersions(version, best.version) > 0) {
      best = { dir, version };
    }
  }
  return best;
}

// ─── Manifest ────────────────────────────────────────────────────────

function manifestPath(skillsRoot: string): string {
  return join(skillsRoot, SKILLS_MANIFEST_NAME);
}

/** 读 manifest；缺失或内容不可识别时返回 undefined，绝不抛。 */
export function readSkillsManifest(skillsRoot: string): UpstreamSkillsManifest | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath(skillsRoot), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const candidate = parsed as Record<string, unknown>;
    const source = candidate['source'];
    const version = candidate['version'];
    const installedAt = candidate['installedAt'];
    const skills = candidate['skills'];
    if (typeof source !== 'string' || typeof version !== 'string') return undefined;
    if (typeof installedAt !== 'string' || !Array.isArray(skills)) return undefined;
    // 结构不符就当作没有 manifest：宁可不删任何东西，也不拿半个 manifest 当所有权。
    if (!skills.every((name): name is string => typeof name === 'string')) return undefined;
    return { source, version, installedAt, skills };
  } catch {
    return undefined;
  }
}

// ─── 规划 ────────────────────────────────────────────────────────────

/**
 * 上游 `skills/` 下只认「目录里带 SKILL.md」的条目；
 * 包里其余的说明性目录（如 references 聚合、脚本目录）不能当 Skill 装。
 */
async function listPackageSkillDirs(pkgDir: string): Promise<string[]> {
  const skillsDir = join(pkgDir, 'skills');
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const entry of entries) {
    try {
      await stat(join(skillsDir, entry, 'SKILL.md'));
      names.push(entry);
    } catch {
      // 文件条目或没有 SKILL.md 的目录：跳过。
    }
  }
  return names.toSorted();
}

/**
 * 纯规划：只读磁盘，不写任何东西。
 * 冲突判定就是所有权判定——目标目录已存在但 manifest 没记过这个名字，
 * 说明那是用户自己的同名 Skill（或别的包装的），覆盖会直接毁掉别人的内容。
 */
export async function planSkillsInstall(
  pkgDir: string,
  skillsRoot: string,
  manifest: UpstreamSkillsManifest | undefined,
  /* injected for deterministic tests */ listSkillDirs: (
    pkgDir: string,
  ) => Promise<string[]> = listPackageSkillDirs,
): Promise<SkillInstallPlan> {
  const owned = new Set(manifest?.skills ?? []);
  const names = await listSkillDirs(pkgDir);
  const plan: SkillInstallPlan = { copy: [], conflicts: [], upToDate: [] };

  for (const name of names) {
    if (!isPlainDirName(name)) continue;
    const to = join(skillsRoot, name);
    if (owned.has(name) || !existsSync(to)) {
      plan.copy.push({ name, from: join(pkgDir, 'skills', name), to });
    } else {
      plan.conflicts.push(name);
    }
  }

  // upToDate 需要「包版本」，而本函数只拿到目录；由 installUpstreamSkills 在知道
  // 版本后补上，避免这里凭空猜一个「已是最新」的结论。
  return plan;
}

/**
 * 写 manifest。失败路径也要用：部分安装的目录必须立刻登记为「我们的」，
 * 否则下一次安装会把它们误判成外来目录而永久跳过。
 */
async function writeManifest(
  skillsRoot: string,
  state: { owned: ReadonlySet<string>; installed: readonly string[]; version: string },
): Promise<void> {
  const next: UpstreamSkillsManifest = {
    source: UPSTREAM_SKILL_SOURCE,
    version: state.version,
    installedAt: new Date().toISOString(),
    skills: [...new Set([...state.owned, ...state.installed])].toSorted(),
  };
  await mkdir(skillsRoot, { recursive: true });
  await writeFile(manifestPath(skillsRoot), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

// ─── 安装 / 移除 ─────────────────────────────────────────────────────

/** 复制规划好的目录，然后写 manifest（必要时创建 skillsRoot）。 */
export async function installUpstreamSkills(
  pkgDir: string,
  version: string,
  skillsRoot: string,
  manifest: UpstreamSkillsManifest | undefined,
): Promise<SkillInstallResult> {
  const plan = await planSkillsInstall(pkgDir, skillsRoot, manifest);
  const owned = new Set(manifest?.skills ?? []);

  // 同版本 + 我们自己的目录：刷新拿不到任何新内容，跳过才配叫「已是最新」。
  const skipped =
    manifest?.version === version
      ? plan.copy.filter((entry) => owned.has(entry.name)).map((entry) => entry.name)
      : [];
  const pending = plan.copy.filter((entry) => !skipped.includes(entry.name));

  const installed: string[] = [];
  if (pending.length > 0) await mkdir(skillsRoot, { recursive: true });
  for (const entry of pending) {
    if (owned.has(entry.name)) {
      // 自己的目录整份替换：升级后上游删掉的文件不能残留在本地冒充最新内容。
      await rm(entry.to, { recursive: true, force: true });
    }
    try {
      await cp(entry.from, entry.to, { recursive: true });
    } catch (error) {
      // 半成品目录必须清掉：manifest 不认它，下次安装会把它当成「别人的同名
      // Skill」永久跳过，一次失败就变成永久残废；已复制完的目录则必须先记账，
      // 否则同样会被误判成外来的。
      try {
        await rm(entry.to, { recursive: true, force: true });
      } catch {
        // 清理失败不该盖掉真正的错误。
      }
      if (installed.length > 0 || owned.size > 0) {
        // 一个都没装成时不要写 manifest：否则面板会把「什么都没装」显示成
        // 「已装 <version>」，用户以为装上了。
        //
        // 版本必须停留在**旧**版本：新版本号会让下一次安装按版本跳过已完成
        // 的那几个，而失败的那个目录此刻已被 rm 掉 —— 于是「已是最新」却是残缺的。
        await writeManifest(skillsRoot, {
          owned,
          installed,
          version: manifest?.version ?? version,
        });
      }
      throw error;
    }
    installed.push(entry.name);
  }

  const nextManifest: UpstreamSkillsManifest = {
    source: UPSTREAM_SKILL_SOURCE,
    version,
    installedAt: new Date().toISOString(),
    skills: [...new Set([...owned, ...installed])].toSorted(),
  };

  // 上游什么都没带、本地也没有历史记录时，不去创建空的 skills 目录和 manifest。
  const hasSomethingToRecord =
    pending.length > 0 || plan.conflicts.length > 0 || manifest !== undefined;
  if (hasSomethingToRecord) {
    await mkdir(skillsRoot, { recursive: true });
    await writeFile(
      manifestPath(skillsRoot),
      `${JSON.stringify(nextManifest, null, 2)}\n`,
      'utf8',
    );
  }

  return {
    installed: installed.toSorted(),
    conflicts: plan.conflicts.toSorted(),
    upToDate: installed.length === 0 ? skipped.toSorted() : [],
    manifest: nextManifest,
  };
}

/** 只删 manifest 列出的目录（我们真正创建过的），然后删 manifest。 */
export interface SkillRemoveResult {
  removed: string[];
  /** Directories that could not be deleted; ownership is kept for them. */
  blocked: string[];
}

export async function removeUpstreamSkills(
  skillsRoot: string,
  manifest: UpstreamSkillsManifest | undefined,
): Promise<SkillRemoveResult> {
  if (manifest === undefined) return { removed: [], blocked: [] };

  const removed: string[] = [];
  const blockedNames: string[] = [];
  for (const name of manifest.skills) {
    if (!isPlainDirName(name)) continue;
    const target = join(skillsRoot, name);
    if (!existsSync(target)) continue;
    try {
      await rm(target, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // 单个目录删不掉（占用 / 权限）不能让整个流程停在半路；
      // 但 manifest 必须留住，否则下次就再也没有所有权凭据了。
      blockedNames.push(name);
    }
  }

  if (blockedNames.length === 0) {
    try {
      await rm(manifestPath(skillsRoot), { force: true });
    } catch {
      // manifest 删不掉不影响已删掉的目录；下次调用会重试。
    }
  }

  return { removed: removed.toSorted(), blocked: blockedNames.toSorted() };
}
