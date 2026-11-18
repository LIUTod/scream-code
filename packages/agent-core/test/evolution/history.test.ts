import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeSharedMemoStore, createMemoryMemo, sharedMemoStore } from '@scream-code/memory';
import { afterEach, describe, expect, it } from 'vitest';

import { listEvolution, rollbackEvolution, showEvolutionChange, snapshotEvolution } from '../../src/evolution/history';

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) {
    closeSharedMemoStore(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evolution-'));
  homes.push(dir);
  return dir;
}

function memo(dir: string, need: string) {
  return createMemoryMemo({
    sourceSessionId: 'job-run-1',
    userNeed: need,
    approach: 'a',
    outcome: 'done',
    whatFailed: 'none',
    whatWorked: 'none',
    extractionSource: 'manual',
    projectDir: dir,
  } as Parameters<typeof createMemoryMemo>[0]);
}

describe('evolution history', () => {
  it('records a skill change and rolls it back', async () => {
    const dir = home();
    mkdirSync(join(dir, 'skills', 'fix-flaky'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'fix-flaky', 'SKILL.md'), 'v1\n');
    expect((await snapshotEvolution(dir, 'add fix-flaky')).ok).toBe(true);

    writeFileSync(join(dir, 'skills', 'fix-flaky', 'SKILL.md'), 'v2\n');
    mkdirSync(join(dir, 'skills', 'new-one'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'new-one', 'SKILL.md'), 'new\n');
    const changed = await snapshotEvolution(dir, 'self-review: improve fix-flaky, add new-one');
    expect(changed.ok && changed.sha).toBeTruthy();
    expect(await snapshotEvolution(dir, 'nothing')).toEqual({ ok: true });

    const changes = await listEvolution(dir);
    expect(changes.map((c) => c.message)).toEqual(['self-review: improve fix-flaky, add new-one', 'add fix-flaky']);
    expect(changes[0]!.files).toEqual(['skills/fix-flaky/SKILL.md', 'skills/new-one/SKILL.md']);
    expect(await showEvolutionChange(dir, changes[0]!.sha)).toContain('+v2');

    const rolled = await rollbackEvolution(dir, changes[0]!.sha);
    expect(rolled.ok).toBe(true);
    expect(readFileSync(join(dir, 'skills', 'fix-flaky', 'SKILL.md'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(dir, 'skills', 'new-one'))).toBe(false);
    expect((await listEvolution(dir))[0]!.message).toBe('rollback: self-review: improve fix-flaky, add new-one');
  });

  it('records a memory change and rolls it back', async () => {
    const dir = home();
    const store = sharedMemoStore(dir);
    await store.init();
    expect((await snapshotEvolution(dir, 'empty')).ok).toBe(true);
    const added = memo(dir, 'learned: run tests twice');
    await store.append(added);
    const snap = await snapshotEvolution(dir, 'self-review: one memory');
    expect(snap.ok && snap.sha).toBeTruthy();
    expect((await rollbackEvolution(dir, (snap as { sha: string }).sha)).ok).toBe(true);
    expect(await store.get(added.id)).toBeUndefined();
  });
});
