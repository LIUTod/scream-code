/**
 * Startup hint for skills / AGENTS.md left in ~/.scream-code after the user
 * moved their Scream home with SCREAM_CODE_HOME.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { legacyUserAssetsNotice } from '#/utils/legacy-user-assets';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function layout(): Promise<{ osHome: string; legacy: string; moved: string }> {
  const root = await mkdtemp(join(tmpdir(), 'legacy-assets-'));
  dirs.push(root);
  const osHome = join(root, 'home');
  const legacy = join(osHome, '.scream-code');
  const moved = join(root, 'Scream Data');
  await mkdir(legacy, { recursive: true });
  await mkdir(moved, { recursive: true });
  return { osHome, legacy, moved };
}

describe('legacyUserAssetsNotice', () => {
  it('names skills and AGENTS.md left behind and where they now belong', async () => {
    const { osHome, legacy, moved } = await layout();
    await mkdir(join(legacy, 'skills', 'mine'), { recursive: true });
    await writeFile(join(legacy, 'AGENTS.md'), 'rules');
    const notice = legacyUserAssetsNotice(moved, osHome);
    expect(notice).toContain(join(legacy, 'skills'));
    expect(notice).toContain(join(legacy, 'AGENTS.md'));
    expect(notice).toContain(moved);
  });

  it('says nothing when the home was not moved', async () => {
    const { osHome, legacy } = await layout();
    await mkdir(join(legacy, 'skills', 'mine'), { recursive: true });
    expect(legacyUserAssetsNotice(legacy, osHome)).toBeUndefined();
  });

  it('says nothing when the moved home is the same directory through a symlink', async () => {
    const { osHome, legacy } = await layout();
    await mkdir(join(legacy, 'skills', 'mine'), { recursive: true });
    const link = join(osHome, 'scream-link');
    await symlink(legacy, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(legacyUserAssetsNotice(link, osHome)).toBeUndefined();
  });

  it('stops once the new location exists, and ignores an empty or hidden-only skills dir', async () => {
    const { osHome, legacy, moved } = await layout();
    await mkdir(join(legacy, 'skills', 'mine'), { recursive: true });
    await mkdir(join(moved, 'skills'));
    expect(legacyUserAssetsNotice(moved, osHome)).toBeUndefined();

    const other = await layout();
    await mkdir(join(other.legacy, 'skills', '.manifest-only'), { recursive: true });
    expect(legacyUserAssetsNotice(other.moved, other.osHome)).toBeUndefined();
  });
});
