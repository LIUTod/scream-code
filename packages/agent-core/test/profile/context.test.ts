import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAgentsMd, prepareSystemPromptContext } from '../../src/profile/context';
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

  it('truncates an oversized AGENTS.md on a character boundary, not one char at a time', async () => {
    // Multi-byte content so a byte-blind cut would leave U+FFFD behind.
    await writeFile(join(workDir, 'AGENTS.md'), '项目说明'.repeat(40_000), 'utf-8');

    const startedAt = Date.now();
    const result = await loadAgentsMd(testJian);
    const elapsed = Date.now() - startedAt;

    // 32 KB budget plus the per-file annotation line.
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(result).not.toContain('\uFFFD');
    expect(result.length).toBeGreaterThan(1_000);
    // Dropping characters one at a time is quadratic here (~9s for this size);
    // the bound is loose enough for a loaded CI runner and still catches it.
    expect(elapsed).toBeLessThan(1_500);
  }, 20_000);

  it('never lets a huge project file delete the user-level conventions', async () => {
    await mkdir(join(homeDir, '.scream-code'), { recursive: true });
    await writeFile(
      join(homeDir, '.scream-code', 'AGENTS.md'),
      'user-level: use the cf CLI unless the project has a wrangler config',
      'utf-8',
    );
    await writeFile(join(workDir, 'AGENTS.md'), 'x'.repeat(120_000), 'utf-8');

    const result = await loadAgentsMd(testJian);

    // The project file overrides its ancestors; it must not starve them.
    expect(result).toContain('use the cf CLI unless the project has a wrangler config');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(32 * 1024);
  });

  it('says what it dropped instead of cutting silently', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'y'.repeat(120_000), 'utf-8');

    const result = await loadAgentsMd(testJian);

    // A silent cut leaves the model believing it read the whole file, so it
    // never opens the rest; the marker names the file and the omitted size.
    expect(result).toMatch(/\[\.\.\. \d+ bytes truncated; read .*AGENTS\.md for the rest\]/);
    expect(result).not.toContain('y'.repeat(40_000));
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(32 * 1024);
  });

  it('keeps a marker and the budget honest when several files compete', async () => {
    await mkdir(join(homeDir, '.scream-code'), { recursive: true });
    // A project root marker so the nested directory is part of the same tree.
    await mkdir(join(workDir, '.git'), { recursive: true });
    await mkdir(join(workDir, 'nested'), { recursive: true });
    await writeFile(join(homeDir, '.scream-code', 'AGENTS.md'), 'global-rule\n', 'utf-8');
    await writeFile(join(workDir, 'AGENTS.md'), 'root-rule\n' + 'r'.repeat(60_000), 'utf-8');
    vi.spyOn(testJian, 'getcwd').mockReturnValue(join(workDir, 'nested'));
    await writeFile(join(workDir, 'nested', 'AGENTS.md'), 'leaf-rule\n' + 'l'.repeat(60_000), 'utf-8');

    const result = await loadAgentsMd(testJian);

    expect(result).toContain('global-rule');
    expect(result).toContain('root-rule');
    expect(result).toContain('leaf-rule');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(32 * 1024);
  });

  it('does not load the same file twice when the work dir is the home dir', async () => {
    vi.spyOn(testJian, 'getcwd').mockReturnValue(homeDir);
    await mkdir(join(homeDir, '.scream-code'), { recursive: true });
    await writeFile(join(homeDir, '.scream-code', 'AGENTS.md'), 'home branded', 'utf-8');

    const result = await loadAgentsMd(testJian);

    expect(result.split('home branded').length - 1).toBe(1);
  });
});

describe('prepareSystemPromptContext roleAdditional', () => {
  const ORIGINAL_HOME_ENV = process.env['SCREAM_CODE_HOME'];

  beforeEach(async () => {
    process.env['SCREAM_CODE_HOME'] = homeDir;
  });

  afterEach(() => {
    if (ORIGINAL_HOME_ENV === undefined) {
      delete process.env['SCREAM_CODE_HOME'];
    } else {
      process.env['SCREAM_CODE_HOME'] = ORIGINAL_HOME_ENV;
    }
  });

  it('returns undefined when user-prefs.md is absent', async () => {
    const context = await prepareSystemPromptContext(testJian);
    expect(context.roleAdditional).toBeUndefined();
  });

  it('loads trimmed user-prefs.md as roleAdditional', async () => {
    await writeFile(
      join(homeDir, 'user-prefs.md'),
      '\n  The user\'s preferred nickname is "Alex".\n  ',
      'utf-8',
    );
    const context = await prepareSystemPromptContext(testJian);
    expect(context.roleAdditional).toBe('The user\'s preferred nickname is "Alex".');
  });

  it('returns undefined when user-prefs.md is empty', async () => {
    await writeFile(join(homeDir, 'user-prefs.md'), '   \n  ', 'utf-8');
    const context = await prepareSystemPromptContext(testJian);
    expect(context.roleAdditional).toBeUndefined();
  });
});
