import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { directoryWithoutSymlink, FixtureFiles } from './browser-isolation';

const cache = path.resolve(import.meta.dirname, '../../../../../node_modules/.cache');
let sandbox: string;
let root: string;
let victim: string;
let files: FixtureFiles;

beforeEach(async () => {
  await fs.mkdir(cache, { recursive: true });
  sandbox = await fs.mkdtemp(path.join(cache, 'browser-isolation-test-'));
  root = path.join(sandbox, 'cache', 'fixture');
  victim = path.join(sandbox, 'outside-cache');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(victim);
  files = new FixtureFiles(root);
});
afterEach(async () => { await fs.rm(sandbox, { recursive: true, force: true }); });

describe('browser fixture filesystem isolation (real filesystem)', () => {
  it('rejects an existing ancestor symlink before mkdir creates anything outside cache', async () => {
    const hop = path.join(sandbox, 'cache', 'hop');
    await fs.symlink(victim, hop);
    await expect(directoryWithoutSymlink(path.join(hop, 'must-not-exist', 'root'))).rejects.toThrow(/symlink/i);
    expect(await fs.readdir(victim)).toEqual([]);
  });

  it.each(['config.toml', 'logs/fixture.log', 'bot/bot.db', 'tmp/nested', 'artifacts/fixture.jsonl', '.browser-fixture.json', 'fixture.sock'])('rejects restored %s symlink despite a legitimate root marker', async (leaf) => {
    await fs.writeFile(path.join(root, '.browser-fixture.json'), JSON.stringify({ kind: 'scream-live-browser-fixture-v1', home: path.join(root, 'home'), workspace: path.join(root, 'workspace') }));
    const target = path.join(victim, 'sentinel');
    await fs.writeFile(target, 'unchanged');
    const link = path.join(root, leaf);
    await fs.mkdir(path.dirname(link), { recursive: true });
    if (leaf === '.browser-fixture.json') await fs.unlink(link);
    await fs.symlink(target, link);
    await expect(files.assertTree()).rejects.toThrow(/symlink/i);
    expect(await fs.readFile(target, 'utf8')).toBe('unchanged');
  });

  it.each([false, true])('refuses file symlink at write/open, dangling=%s', async (dangling) => {
    const target = path.join(victim, 'sentinel');
    if (!dangling) await fs.writeFile(target, 'unchanged');
    const link = path.join(root, 'config.toml');
    await fs.symlink(target, link);
    await expect(files.write(link, 'must not be written')).rejects.toThrow();
    if (dangling) await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await fs.readFile(target, 'utf8')).toBe('unchanged');
  });

  it('rejects a writable path escaping root and an ancestor link before creating children', async () => {
    await expect(files.write(path.join(victim, 'escape'), 'bad')).rejects.toThrow(/escape/);
    await fs.symlink(victim, path.join(root, 'logs'));
    await expect(files.open(path.join(root, 'logs', 'new-dir', 'log'), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY)).rejects.toThrow(/symlink/i);
    expect(await fs.readdir(victim)).toEqual([]);
  });

  it('creates ordinary nested files and supports a same-root restore without replacing data', async () => {
    await files.write(path.join(root, 'home', 'config.toml'), 'dummy fixture config');
    await files.assertTree();
    const restored = new FixtureFiles(root);
    const log = await restored.open(path.join(root, 'artifacts', 'fixture.jsonl'), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY);
    try { await log.writeFile('first\n'); await log.writeFile('restored\n'); } finally { await log.close(); }
    expect(await fs.readFile(path.join(root, 'artifacts', 'fixture.jsonl'), 'utf8')).toBe('first\nrestored\n');
    expect(await fs.readFile(path.join(root, 'home', 'config.toml'), 'utf8')).toBe('dummy fixture config');
  });
});
