import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sharedKnowledgeStore, sharedKnowledgeStoreReady } from '../src/shared-store.js';

describe('sharedKnowledgeStore', () => {
  it('returns the same instance for the same homeDir and different ones otherwise', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'shared-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'shared-b-'));

    const a1 = sharedKnowledgeStore(dirA);
    const a2 = sharedKnowledgeStore(dirA);
    const b = sharedKnowledgeStore(dirB);

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);

    await sharedKnowledgeStoreReady(dirA);
    await sharedKnowledgeStoreReady(dirB);
  });

  it('wires the embedding engine before ready resolves and shares one ready promise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-ready-'));

    const ready1 = sharedKnowledgeStoreReady(dir);
    const ready2 = sharedKnowledgeStoreReady(dir);
    expect(ready1).toBe(ready2);
    await ready1;

    const engine = sharedKnowledgeStore(dir).getEmbeddingEngine();
    expect(engine).toBeDefined();
  });

  it('deletes the entry on a failed build so the next caller gets a fresh instance', async () => {
    // A plain file as the parent makes mkdir/join paths fail deterministically.
    const filePath = join(mkdtempSync(join(tmpdir(), 'shared-f-')), 'blocker');
    writeFileSync(filePath, 'x');
    const homeDir = join(filePath, 'home');

    const first = sharedKnowledgeStore(homeDir);
    await expect(sharedKnowledgeStoreReady(homeDir)).rejects.toThrow();

    const second = sharedKnowledgeStore(homeDir);
    expect(second).not.toBe(first);
    await expect(sharedKnowledgeStoreReady(homeDir)).rejects.toThrow();
  });
});
