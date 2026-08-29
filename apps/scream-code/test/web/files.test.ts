import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileAccessError, FileGate, MAX_FILE_READ } from '#/web/files';

const tempDirs: string[] = [];

async function makeRoots(): Promise<{ root: string; outside: string; gate: FileGate }> {
  const root = await mkdtemp(join(tmpdir(), 'scream-files-'));
  const outside = await mkdtemp(join(tmpdir(), 'scream-files-out-'));
  tempDirs.push(root, outside);
  await writeFile(join(root, 'README.md'), '# hello');
  await writeFile(join(outside, 'secret.txt'), 'top secret');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'main.ts'), 'export const x = 1;');
  return { root, outside, gate: new FileGate(() => [root]) };
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('FileGate', () => {
  it('lists a directory with dirs first, sorted by name', async () => {
    const { root, gate } = await makeRoots();
    const entries = await gate.list(root);
    expect(entries.map((e) => e.name)).toEqual(['src', 'README.md']);
    expect(entries[0]!.type).toBe('dir');
    expect(entries[1]!.type).toBe('file');
  });

  it('reads a text file inside the root', async () => {
    const { root, gate } = await makeRoots();
    const result = await gate.read(join(root, 'README.md'));
    expect(result.content).toBe('# hello');
    expect(result.truncated).toBe(false);
  });

  it('rejects ../ traversal escapes', async () => {
    const { root, gate } = await makeRoots();
    await expect(gate.read(join(root, '..', '..', 'secret.txt'))).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects absolute paths outside every root', async () => {
    const { outside, gate } = await makeRoots();
    await expect(gate.read(join(outside, 'secret.txt'))).rejects.toMatchObject({ statusCode: 403 });
  });

  it('resolves relative paths against the first root', async () => {
    const { root, gate } = await makeRoots();
    const result = await gate.read('README.md');
    expect(result.path).toBe(join(root, 'README.md'));
  });

  it('blocks symlinks escaping the boundary', async () => {
    const { root, outside, gate } = await makeRoots();
    try {
      await symlink(outside, join(root, 'escape'), 'dir');
    } catch {
      return; // symlinks unavailable on this platform; skip
    }
    await expect(gate.list(join(root, 'escape'))).rejects.toMatchObject({ statusCode: 403 });
    await expect(gate.read('escape/secret.txt')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('truncates reads beyond MAX_FILE_READ with the truncated flag', async () => {
    const { root, gate } = await makeRoots();
    await writeFile(join(root, 'big.txt'), 'x'.repeat(MAX_FILE_READ + 1000));
    const result = await gate.read(join(root, 'big.txt'));
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(MAX_FILE_READ);
  });

  it('rejects when there are no roots (no sessions yet)', async () => {
    const gate = new FileGate(() => []);
    await expect(gate.list('/tmp')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('classifies preview kinds by mime', async () => {
    const gate = new FileGate(() => []);
    expect(gate.previewKind('a.png')).toBe('image');
    expect(gate.previewKind('b.mp3')).toBe('audio');
    expect(gate.previewKind('c.pdf')).toBe('pdf');
    expect(gate.previewKind('d.md')).toBe('text');
    expect(gate.previewKind('e.zip')).toBeNull();
  });
});
