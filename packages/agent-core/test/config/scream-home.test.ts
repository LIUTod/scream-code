/**
 * The Scream home, and the user data that follows it. `SCREAM_CODE_HOME` is
 * set by hand on every platform, often where no shell expands it, so the
 * resolver accepts what people actually type; and moving the home moves the
 * user's own skills and AGENTS.md too, not only config and sessions.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'pathe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveScreamHome, screamHomeFromEnv } from '../../src/config/path';
import { loadAgentsMd } from '../../src/profile/context';
import { resolveSkillInstallPaths, resolveSkillInstallUnit, resolveSkillRoots, userSkillsDir } from '../../src/skill';
import { testJian } from '../fixtures/test-jian';

const dirs: string[] = [];
const originalHome = process.env['SCREAM_CODE_HOME'];
afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env['SCREAM_CODE_HOME'];
  else process.env['SCREAM_CODE_HOME'] = originalHome;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scream-home-'));
  dirs.push(dir);
  return dir;
}

describe('SCREAM_CODE_HOME as users set it', () => {
  it('treats blank as unset', () => {
    expect(screamHomeFromEnv(undefined)).toBeUndefined();
    expect(screamHomeFromEnv('')).toBeUndefined();
    expect(screamHomeFromEnv('   ')).toBeUndefined();
    expect(screamHomeFromEnv('""')).toBeUndefined();
    process.env['SCREAM_CODE_HOME'] = '';
    expect(resolveScreamHome()).toBe(join(homedir(), '.scream-code'));
  });

  it('drops one pair of surrounding quotes (cmd keeps them in the value)', () => {
    expect(screamHomeFromEnv('"/data/scream"')).toBe('/data/scream');
    expect(screamHomeFromEnv("'/data/scream'")).toBe('/data/scream');
    expect(screamHomeFromEnv('"/data/scream')).toBe(resolve('"/data/scream'));
  });

  it('expands a leading ~ with either separator', () => {
    expect(screamHomeFromEnv('~')).toBe(resolve(homedir()));
    expect(screamHomeFromEnv('~/scream')).toBe(resolve(homedir(), 'scream'));
    expect(screamHomeFromEnv('~\\scream')).toBe(resolve(homedir(), 'scream'));
    // `~user` is not the current user's home; it is left as a path.
    expect(screamHomeFromEnv('~other/x')).toBe(resolve('~other/x'));
  });

  it('makes a relative path absolute and keeps an absolute one', () => {
    expect(screamHomeFromEnv('rel/home')).toBe(resolve('rel/home'));
    expect(screamHomeFromEnv('/abs/home')).toBe('/abs/home');
  });

  it('an explicit home wins over the variable', () => {
    process.env['SCREAM_CODE_HOME'] = '/from/env';
    expect(resolveScreamHome('/explicit')).toBe('/explicit');
    expect(resolveScreamHome()).toBe('/from/env');
  });
});

describe('user skills follow the Scream home', () => {
  it('discovers and installs user skills in <scream home>/skills, ~/.agents/skills in the OS home', async () => {
    const root = await tmp();
    const osHome = join(root, 'home');
    const screamHome = join(root, 'Scream Data');
    const workDir = join(root, 'work');
    await mkdir(join(screamHome, 'skills'), { recursive: true });
    await mkdir(join(osHome, '.agents', 'skills'), { recursive: true });
    // Left behind by an older build: no longer scanned once the home moved.
    await mkdir(join(osHome, '.scream-code', 'skills'), { recursive: true });
    await mkdir(workDir, { recursive: true });

    const paths = { userHomeDir: osHome, screamHomeDir: screamHome, workDir };
    const roots = await resolveSkillRoots({ paths });
    const userRoots = roots.filter((r) => r.source === 'user').map((r) => r.path);
    expect(userRoots).toEqual([
      (await realpath(join(screamHome, 'skills'))).replaceAll('\\', '/'),
      (await realpath(join(osHome, '.agents', 'skills'))).replaceAll('\\', '/'),
    ]);

    expect(userSkillsDir(paths)).toBe(join(screamHome, 'skills'));
    expect((await resolveSkillInstallPaths(paths)).userDir).toBe(join(screamHome, 'skills'));
    // Without a Scream home the default stays ~/.scream-code/skills.
    expect(userSkillsDir({ userHomeDir: osHome })).toBe(join(osHome, '.scream-code', 'skills'));
  });

  it('finds the install unit under a user skill directory of any name', () => {
    const userRoot = '/data/Scream Data/skills';
    expect(resolveSkillInstallUnit(`${userRoot}/my-skill/SKILL.md`, [userRoot])).toBe(`${userRoot}/my-skill`);
    expect(resolveSkillInstallUnit(`${userRoot}/flat.md`, [userRoot])).toBe(`${userRoot}/flat.md`);
    expect(resolveSkillInstallUnit(`${userRoot}/pack/sub/SKILL.md`, [`${userRoot}/`])).toBe(`${userRoot}/pack`);
    // Without the explicit root that directory is not recognisable by name.
    expect(() => resolveSkillInstallUnit(`${userRoot}/my-skill/SKILL.md`)).toThrow(/managed skill root/);
    // The conventional layouts keep working with no roots given.
    expect(resolveSkillInstallUnit('/home/u/.scream-code/skills/a/SKILL.md')).toBe('/home/u/.scream-code/skills/a');
  });
});

describe('user AGENTS.md follows the Scream home', () => {
  it('reads <scream home>/AGENTS.md, not the one left in ~/.scream-code', async () => {
    const root = await tmp();
    const osHome = join(root, 'home');
    const screamHome = join(root, 'scream');
    const workDir = join(root, 'work');
    await mkdir(join(osHome, '.scream-code'), { recursive: true });
    await mkdir(screamHome, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(join(osHome, '.scream-code', 'AGENTS.md'), 'left behind', 'utf-8');
    await writeFile(join(screamHome, 'AGENTS.md'), 'moved with the home', 'utf-8');
    vi.spyOn(testJian, 'gethome').mockReturnValue(osHome);
    vi.spyOn(testJian, 'getcwd').mockReturnValue(workDir);

    const moved = await loadAgentsMd(testJian, screamHome);
    expect(moved).toContain('moved with the home');
    expect(moved).not.toContain('left behind');
    // No Scream home given: the one SCREAM_CODE_HOME resolves to.
    process.env['SCREAM_CODE_HOME'] = screamHome;
    expect(await loadAgentsMd(testJian)).toContain('moved with the home');
  });
});
