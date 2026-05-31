import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAgentsMd } from '../../src/profile/context';
import { testJian } from '../fixtures/test-jian';

let homeDir: string;
let workDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'scream-agents-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'scream-agents-work-'));
  vi.spyOn(testJian, 'gethome').mockReturnValue(homeDir);
  vi.spyOn(testJian, 'getcwd').mockReturnValue(workDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

describe('loadAgentsMd user-level discovery', () => {
  it('loads user-level branded and generic files before project-level', async () => {
    await mkdir(join(homeDir, '.scream-code'), { recursive: true });
    await writeFile(join(homeDir, '.scream-code', 'AGENTS.md'), 'user branded', 'utf-8');
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'user generic', 'utf-8');
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');

    const result = await loadAgentsMd(testJian);

    expect(result).toContain('user branded');
    expect(result).toContain('user generic');
    expect(result).toContain('project instructions');
    expect(result.indexOf('user branded')).toBeLessThan(result.indexOf('user generic'));
    expect(result.indexOf('user generic')).toBeLessThan(result.indexOf('project instructions'));
  });

  it('loads generic user-level .agents/AGENTS.md', async () => {
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'dot-agents generic', 'utf-8');

    const result = await loadAgentsMd(testJian);

    expect(result).toContain('dot-agents generic');
  });

  it('falls back to project-level only when no user-level files exist', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project only', 'utf-8');

    const result = await loadAgentsMd(testJian);

    expect(result).toContain('project only');
    expect(result).not.toContain(homeDir);
  });

  it('does not load the same file twice when the work dir is the home dir', async () => {
    vi.spyOn(testJian, 'getcwd').mockReturnValue(homeDir);
    await mkdir(join(homeDir, '.scream-code'), { recursive: true });
    await writeFile(join(homeDir, '.scream-code', 'AGENTS.md'), 'home branded', 'utf-8');

    const result = await loadAgentsMd(testJian);

    expect(result.split('home branded').length - 1).toBe(1);
  });
});
