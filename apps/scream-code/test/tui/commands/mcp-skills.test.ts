/**
 * mcp-skills.test.ts — chrome-devtools-mcp 上游 Skill 安装器。
 *
 * 全部走真实 fs：临时目录里手工搭出 npx 缓存树（`_npx/<hash>/node_modules/...`）
 * 和用户 skills 目录，不用 mock，也不联网。重点验证三条规则：
 * 1. 版本取最高（旧 npx 目录不会被清理）；
 * 2. 只有 manifest 记过的目录名才允许覆盖/删除，同名外部目录进 conflicts 且原样保留；
 * 3. 读写失败一律降级为 undefined / []，不让面板崩。
 */
import { chmodSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SKILLS_MANIFEST_NAME,
  UPSTREAM_SKILL_SOURCE,
  findPackageSkillsLocation,
  installUpstreamSkills,
  planSkillsInstall,
  readSkillsManifest,
  removeUpstreamSkills,
  type UpstreamSkillsManifest,
} from '#/tui/commands/mcp-skills';

// ─── 临时目录与假包 ──────────────────────────────────────────────────

const tempRoots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface FakeSkill {
  name: string;
  body?: string;
  /** 额外文件，键为相对 skill 目录的路径。 */
  files?: Record<string, string>;
}

async function writePackage(
  pkgDir: string,
  version: string,
  skills: FakeSkill[],
): Promise<void> {
  await mkdir(join(pkgDir, 'skills'), { recursive: true });
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: UPSTREAM_SKILL_SOURCE, version }, null, 2),
  );
  for (const skill of skills) {
    const dir = join(pkgDir, 'skills', skill.name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: ${skill.name}\ndescription: ${skill.name} upstream skill\n---\n\n${skill.body ?? 'body'}\n`,
    );
    for (const [relative, content] of Object.entries(skill.files ?? {})) {
      const file = join(dir, relative);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    }
  }
  // 上游还带一些说明性目录；没有 SKILL.md 就不是 Skill，必须被忽略。
  await mkdir(join(pkgDir, 'skills', 'shared-notes'), { recursive: true });
  await writeFile(join(pkgDir, 'skills', 'shared-notes', 'README.md'), 'not a skill\n');
}

async function addNpxPackage(
  cacheRoot: string,
  hash: string,
  version: string,
  skills: FakeSkill[],
): Promise<string> {
  const pkgDir = join(cacheRoot, '_npx', hash, 'node_modules', UPSTREAM_SKILL_SOURCE);
  await writePackage(pkgDir, version, skills);
  return pkgDir;
}

async function readManifestFile(skillsRoot: string): Promise<UpstreamSkillsManifest> {
  const raw = await readFile(join(skillsRoot, SKILLS_MANIFEST_NAME), 'utf8');
  return JSON.parse(raw) as UpstreamSkillsManifest;
}

async function writeSkill(dir: string, name: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} local skill\n---\n\n${body}\n`,
  );
}

// ─── 用例 ────────────────────────────────────────────────────────────

describe('findPackageSkillsLocation', () => {
  it('在多个 npx 缓存目录中挑出版本最高的包，坏的 package.json 不参与比较', async () => {
    const cacheRoot = await makeRoot('scream-mcp-skills-cache-');
    await addNpxPackage(cacheRoot, 'old-hash', '1.9.0', [{ name: 'chrome-devtools' }]);
    const newest = await addNpxPackage(cacheRoot, 'new-hash', '1.13.0', [
      { name: 'chrome-devtools' },
    ]);
    // 1.10.0 的字符串序大于 1.9.0，但数字序更小；再放一个坏包干扰。
    await addNpxPackage(cacheRoot, 'mid-hash', '1.10.0', [{ name: 'chrome-devtools' }]);
    const broken = join(cacheRoot, '_npx', 'broken-hash', 'node_modules', UPSTREAM_SKILL_SOURCE);
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'package.json'), '{ not json');

    expect(findPackageSkillsLocation(cacheRoot)).toEqual({ dir: newest, version: '1.13.0' });
    expect(findPackageSkillsLocation(join(cacheRoot, 'nope'))).toBeUndefined();
  });
});

describe('planSkillsInstall / installUpstreamSkills', () => {
  it('复制 SKILL.md 与嵌套 references，写排序后的 manifest；同版本重装报 upToDate', async () => {
    const root = await makeRoot('scream-mcp-skills-install-');
    const pkgDir = await addNpxPackage(root, 'hash', '1.13.0', [
      { name: 'chrome-devtools' },
      { name: 'a11y-debugging', files: { 'references/x.md': '# deep dive\n' } },
    ]);
    const skillsRoot = join(root, 'user-skills');

    const plan = await planSkillsInstall(pkgDir, skillsRoot, undefined);
    expect(plan.copy.map((entry) => entry.name)).toEqual(['a11y-debugging', 'chrome-devtools']);
    expect(plan.conflicts).toEqual([]);
    expect(plan.upToDate).toEqual([]);

    const result = await installUpstreamSkills(pkgDir, '1.13.0', skillsRoot, undefined);
    expect(result.installed).toEqual(['a11y-debugging', 'chrome-devtools']);
    expect(result.conflicts).toEqual([]);
    expect(result.upToDate).toEqual([]);
    expect(result.manifest.source).toBe(UPSTREAM_SKILL_SOURCE);
    expect(result.manifest.version).toBe('1.13.0');
    expect(result.manifest.skills).toEqual(['a11y-debugging', 'chrome-devtools']);
    expect(result.manifest.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(await readFile(join(skillsRoot, 'a11y-debugging', 'references', 'x.md'), 'utf8')).toBe(
      '# deep dive\n',
    );
    expect(existsSync(join(skillsRoot, 'chrome-devtools', 'SKILL.md'))).toBe(true);
    // 上游的说明目录不是 Skill，不复制。
    expect(existsSync(join(skillsRoot, 'shared-notes'))).toBe(false);

    const written = await readManifestFile(skillsRoot);
    expect(written).toEqual(result.manifest);
    expect(readSkillsManifest(skillsRoot)).toEqual(result.manifest);

    const again = await installUpstreamSkills(
      pkgDir,
      '1.13.0',
      skillsRoot,
      readSkillsManifest(skillsRoot),
    );
    expect(again.installed).toEqual([]);
    expect(again.conflicts).toEqual([]);
    expect(again.upToDate).toEqual(['a11y-debugging', 'chrome-devtools']);
  });

  it('同名外部目录进 conflicts 并保持原样，其余 Skill 照常安装', async () => {
    const root = await makeRoot('scream-mcp-skills-conflict-');
    const pkgDir = await addNpxPackage(root, 'hash', '1.13.0', [
      { name: 'a11y-debugging' },
      { name: 'chrome-devtools' },
    ]);
    const skillsRoot = join(root, 'user-skills');
    const foreignDir = join(skillsRoot, 'a11y-debugging');
    await writeSkill(foreignDir, 'a11y-debugging', 'foreign body');

    const plan = await planSkillsInstall(pkgDir, skillsRoot, undefined);
    expect(plan.conflicts).toEqual(['a11y-debugging']);
    expect(plan.copy.map((entry) => entry.name)).toEqual(['chrome-devtools']);

    const result = await installUpstreamSkills(pkgDir, '1.13.0', skillsRoot, undefined);
    expect(result.installed).toEqual(['chrome-devtools']);
    expect(result.conflicts).toEqual(['a11y-debugging']);
    expect(result.manifest.skills).toEqual(['chrome-devtools']);

    const foreignContent = await readFile(join(foreignDir, 'SKILL.md'), 'utf8');
    expect(foreignContent).toContain('foreign body');
    expect(foreignContent).not.toContain('upstream skill');
  });

  it('升级到新版本时替换自己的目录（清掉旧残留文件）并更新 manifest 版本', async () => {
    const root = await makeRoot('scream-mcp-skills-update-');
    const oldPkg = await addNpxPackage(root, 'old-hash', '1.13.0', [
      { name: 'chrome-devtools', body: 'v13 body' },
      { name: 'debug-optimize-lcp' },
    ]);
    const newPkg = await addNpxPackage(root, 'new-hash', '1.14.0', [
      { name: 'chrome-devtools', body: 'v14 body' },
      { name: 'debug-optimize-lcp' },
    ]);
    const skillsRoot = join(root, 'user-skills');

    await installUpstreamSkills(oldPkg, '1.13.0', skillsRoot, undefined);
    // 上游 1.14.0 已删掉的文件：整份替换后不能残留。
    await writeFile(join(skillsRoot, 'chrome-devtools', 'stale.md'), 'stale\n');

    const updated = await installUpstreamSkills(
      newPkg,
      '1.14.0',
      skillsRoot,
      readSkillsManifest(skillsRoot),
    );
    expect(updated.installed).toEqual(['chrome-devtools', 'debug-optimize-lcp']);
    expect(updated.conflicts).toEqual([]);
    expect(updated.upToDate).toEqual([]);
    expect(updated.manifest.version).toBe('1.14.0');
    expect(updated.manifest.skills).toEqual(['chrome-devtools', 'debug-optimize-lcp']);

    expect(await readFile(join(skillsRoot, 'chrome-devtools', 'SKILL.md'), 'utf8')).toContain(
      'v14 body',
    );
    expect(existsSync(join(skillsRoot, 'chrome-devtools', 'stale.md'))).toBe(false);
    expect(readSkillsManifest(skillsRoot)?.version).toBe('1.14.0');
  });

  it('上游没有 skills 目录时 installed 为空且不抛错', async () => {
    const root = await makeRoot('scream-mcp-skills-missing-');
    const pkgDir = join(root, '_npx', 'hash', 'node_modules', UPSTREAM_SKILL_SOURCE);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: UPSTREAM_SKILL_SOURCE, version: '1.15.0' }),
    );
    const skillsRoot = join(root, 'user-skills');

    await expect(planSkillsInstall(pkgDir, skillsRoot, undefined)).resolves.toEqual({
      copy: [],
      conflicts: [],
      upToDate: [],
    });

    const result = await installUpstreamSkills(pkgDir, '1.15.0', skillsRoot, undefined);
    expect(result.installed).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.upToDate).toEqual([]);
    // 没有任何东西可记录时，不该凭空建出 skills 目录和 manifest。
    expect(existsSync(skillsRoot)).toBe(false);
    expect(readSkillsManifest(skillsRoot)).toBeUndefined();
  });
});

describe('removeUpstreamSkills', () => {
  it('只删 manifest 列出的目录，外部同名兄弟目录保留，manifest 一并删除', async () => {
    const root = await makeRoot('scream-mcp-skills-remove-');
    const pkgDir = await addNpxPackage(root, 'hash', '1.13.0', [
      { name: 'a11y-debugging' },
      { name: 'chrome-devtools' },
    ]);
    const skillsRoot = join(root, 'user-skills');
    await writeSkill(join(skillsRoot, 'my-own-skill'), 'my-own-skill', 'mine');

    const installed = await installUpstreamSkills(pkgDir, '1.13.0', skillsRoot, undefined);
    expect(installed.installed).toEqual(['a11y-debugging', 'chrome-devtools']);

    const removed = await removeUpstreamSkills(
      skillsRoot,
      readSkillsManifest(skillsRoot),
    );
    expect(removed).toEqual({ removed: ['a11y-debugging', 'chrome-devtools'], blocked: [] });
    expect(existsSync(join(skillsRoot, 'a11y-debugging'))).toBe(false);
    expect(existsSync(join(skillsRoot, 'chrome-devtools'))).toBe(false);
    expect(existsSync(join(skillsRoot, SKILLS_MANIFEST_NAME))).toBe(false);
    expect(existsSync(join(skillsRoot, 'my-own-skill', 'SKILL.md'))).toBe(true);
    expect(await readFile(join(skillsRoot, 'my-own-skill', 'SKILL.md'), 'utf8')).toContain('mine');

    // 没有 manifest 就什么都不删。
    await expect(removeUpstreamSkills(skillsRoot, undefined)).resolves.toEqual({
      removed: [],
      blocked: [],
    });
  });
});

// ─── 部分安装失败的自愈 ──────────────────────────────────────────────
//
// 复制到一半失败（权限、磁盘满）时，已经写下的目录如果不记进 manifest，
// 下一次安装会把它们当成「别人的同名 Skill」永久跳过——一次失败变成永久残废。

describe('installUpstreamSkills 部分失败', () => {
  it('失败前已复制的目录会记进 manifest，下次安装能补齐', async () => {
    const root = await makeRoot('skills-partial-');
    const pkg = join(root, 'pkg');
    const skills = join(root, 'skills');
    await writePackage(pkg, '1.13.0', [
      { name: 'aaa-good' },
      { name: 'zzz-bad' },
    ]);
    // 让排序靠后的那个 SKILL.md 不可读：目录本身仍可遍历（否则它会被当成
    // 「不是 Skill」直接跳过），cp 在读取内容时失败——正是部分安装的场景。
    const badFile = join(pkg, 'skills', 'zzz-bad', 'SKILL.md');
    chmodSync(badFile, 0o000);
    try {
      await expect(
        installUpstreamSkills(pkg, '1.13.0', skills, undefined),
      ).rejects.toThrow();

      // 已复制的那个必须被认领，否则会永远进 conflicts。
      const manifest = readSkillsManifest(skills);
      expect(manifest?.skills).toEqual(['aaa-good']);
      expect(existsSync(join(skills, 'aaa-good', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(skills, 'zzz-bad'))).toBe(false);

      // 权限恢复后重装：补齐缺的那个，不把 aaa-good 当冲突。
      chmodSync(badFile, 0o600);
      const retry = await installUpstreamSkills(pkg, '1.13.0', skills, manifest);
      expect(retry.conflicts).toEqual([]);
      expect(retry.installed).toEqual(['zzz-bad']);
      expect(readSkillsManifest(skills)?.skills).toEqual(['aaa-good', 'zzz-bad']);
    } finally {
      chmodSync(badFile, 0o600);
    }
  });

  it('manifest 里的名字若被手改成路径（../x）则拒绝删除，不越界', async () => {
    const root = await makeRoot('skills-traversal-');
    const skills = join(root, 'skills');
    await mkdir(skills, { recursive: true });
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'keep.txt'), 'do not delete');
    const manifest: UpstreamSkillsManifest = {
      source: UPSTREAM_SKILL_SOURCE,
      version: '1.13.0',
      installedAt: new Date().toISOString(),
      skills: ['../outside'],
    };

    const removed = await removeUpstreamSkills(skills, manifest);

    expect(removed.removed).toEqual([]);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });
});
