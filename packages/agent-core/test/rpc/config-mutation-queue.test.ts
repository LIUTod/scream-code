import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ScreamCore } from '../../src/rpc/core-impl';

/**
 * Regression guard for the /model picker "wiggle" pattern: cycling thinking
 * levels (←/→) fires a setConfig patch per keypress, and confirming a model
 * fires another. Those read-modify-write cycles used to run unserialized —
 * both read the same file snapshot and the later write reverted the earlier
 * patch (lost update), so a just-selected default model could silently flip
 * back to the old one. setScreamConfig must now serialize mutations.
 */
const dirs: string[] = [];

async function makeCore(): Promise<ScreamCore> {
  const home = await mkdtemp(join(tmpdir(), 'scream-core-cfg-'));
  dirs.push(home);
  const core = new ScreamCore(async () => ({}) as never, { homeDir: home });
  await new Promise((r) => setImmediate(r));
  return core;
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs.length = 0;
});

describe('setScreamConfig mutation serialization', () => {
  it('concurrent patches both survive (no lost update)', async () => {
    const core = await makeCore();

    await Promise.all([
      core.setScreamConfig({ defaultModel: 'alpha' }),
      core.setScreamConfig({ defaultThinking: true, thinking: { mode: 'on', effort: 'low' } }),
    ]);

    const persisted = await readFile(core.configPath, 'utf-8');
    expect(persisted).toMatch(/default_model\s*=\s*"alpha"/);
    expect(persisted).toMatch(/default_thinking\s*=\s*true/);
    // The in-memory config must reflect both patches as well.
    const config = await core.getScreamConfig({ reload: true });
    expect(config.defaultModel).toBe('alpha');
    expect(config.defaultThinking).toBe(true);
  });

  it('each queued cycle re-reads the file after the previous write', async () => {
    const core = await makeCore();

    const results = await Promise.all([
      core.setScreamConfig({ defaultModel: 'first' }),
      core.setScreamConfig({ defaultModel: 'second' }),
      core.setScreamConfig({ defaultModel: 'third' }),
    ]);

    // Last-writer-wins by queue ORDER, not by completion race.
    expect(results[2]!.defaultModel).toBe('third');
    const config = await core.getScreamConfig({ reload: true });
    expect(config.defaultModel).toBe('third');
  });

  it('removeScreamProvider composes with concurrent setScreamConfig', async () => {
    const core = await makeCore();
    await core.setScreamConfig({
      providers: {
        p1: { type: 'openai', baseUrl: 'http://127.0.0.1:1/v1' },
        p2: { type: 'openai', baseUrl: 'http://127.0.0.1:2/v1' },
      },
    });

    await Promise.all([
      core.removeScreamProvider({ providerId: 'p1' }),
      core.setScreamConfig({ defaultModel: 'keepme' }),
    ]);

    const persisted = await readFile(core.configPath, 'utf-8');
    expect(persisted).not.toContain('p1');
    expect(persisted).toContain('p2');
    expect(persisted).toMatch(/default_model\s*=\s*"keepme"/);
  });

  it('failed mutations reject to the caller and never wedge the queue', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scream-core-cfgbad-'));
    dirs.push(home);
    // Read-only parent directory: mkdir is fine but every file write fails
    // with EACCES, so each mutation rejects while the queue keeps draining.
    const roDir = join(home, 'ro');
    await mkdir(roDir, { recursive: true });
    await chmod(roDir, 0o500);
    const core = new ScreamCore(async () => ({}) as never, {
      homeDir: home,
      configPath: join(roDir, 'config.toml'),
    });
    await new Promise((r) => setImmediate(r));

    try {
      await expect(core.setScreamConfig({ defaultModel: 'a' })).rejects.toThrow();
      // If the queue had inherited the rejection the promise would never
      // settle and this second call would time out the test.
      await expect(core.setScreamConfig({ defaultModel: 'b' })).rejects.toThrow();
    } finally {
      await chmod(roDir, 0o700);
    }
  });
});
