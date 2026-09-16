import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Jian } from '@scream-code/jian';

import { testJian } from '../fixtures/test-jian';
import { Session } from '../../src/session';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scream-session-meta-'));
  tempDirs.push(dir);
  return dir;
}

function makeSession(homedir: string, jian: Jian = testJian.withCwd(homedir)): Session {
  return new Session({
    id: 'test-meta',
    jian,
    homedir,
    rpc: {} as never,
  });
}

describe('Session.readMetadata resilience', () => {
  it('returns default metadata when state.json is truncated (mid-write kill)', async () => {
    const homedir = await makeTempDir();
    // Plain writeFile truncates before writing; a process killed in between
    // leaves exactly this 0-byte state behind.
    await writeFile(join(homedir, 'state.json'), '', 'utf-8');

    const session = makeSession(homedir);
    const meta = await session.readMetadata();

    expect(meta.title).toBe('New Session');
    expect(meta.agents).toEqual({});
    expect(meta.custom).toEqual({});
  });

  it('returns default metadata when state.json does not exist', async () => {
    const homedir = await makeTempDir();

    const session = makeSession(homedir);
    const meta = await session.readMetadata();

    expect(meta.title).toBe('New Session');
    expect(meta.agents).toEqual({});
  });

  it('propagates transient read failures instead of masking them', async () => {
    const homedir = await makeTempDir();
    // A directory at the state.json path makes readFile fail with EISDIR —
    // a transient/non-ENOENT error. Masking it would let a later
    // writeMetadata persist synthetic defaults over real data.
    await mkdir(join(homedir, 'state.json'));

    const session = makeSession(homedir);
    await expect(session.readMetadata()).rejects.toThrow();
  });

  it('parses a valid state.json', async () => {
    const homedir = await makeTempDir();
    await writeFile(
      join(homedir, 'state.json'),
      JSON.stringify({ title: 'Test Session', isCustomTitle: true, agents: { main: { id: 'main' } }, custom: {} }),
      'utf-8',
    );

    const session = makeSession(homedir);
    const meta = await session.readMetadata();

    expect(meta.title).toBe('Test Session');
    expect(meta.isCustomTitle).toBe(true);
  });

  it('writeMetadata goes through the atomic write path', async () => {
    const homedir = await makeTempDir();
    const jian = testJian.withCwd(homedir);
    // Contract guard: reverting writeMetadata to plain writeText trips both
    // spy assertions below, pinning the regression the atomic write exists
    // for — a truncated state.json silently resets the session to default
    // metadata and loses the whole agent topology.
    const atomicSpy = vi.spyOn(jian, 'writeTextAtomic');
    const plainSpy = vi.spyOn(jian, 'writeText');
    const session = makeSession(homedir, jian);
    await session.writeMetadata();

    expect(atomicSpy).toHaveBeenCalledTimes(1);
    expect(plainSpy).not.toHaveBeenCalled();

    // The swap must leave exactly one file: a complete state.json, with no
    // tmp residue behind.
    const text = await readFile(join(homedir, 'state.json'), 'utf-8');
    const parsed = JSON.parse(text) as { title?: string };
    expect(parsed.title).toBe('New Session');
    const entries = await readdir(homedir);
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });
});
