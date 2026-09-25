import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MemoryMemoStore } from '../src/store.js';
import { createMemoryMemo } from '../src/models.js';
import type { MemoryMemo } from '../src/models.js';

function makeMemo(overrides: Partial<MemoryMemo> = {}): MemoryMemo {
  return createMemoryMemo({
    userNeed: 'Test requirement',
    approach: 'Test solution',
    outcome: '完成',
    whatFailed: 'none',
    whatWorked: 'none',
    extractionSource: 'compaction',
    sourceSessionId: 'test-session',
    sourceSessionTitle: 'Test Session',
    ...overrides,
  });
}

describe('SQLite-backed MemoryMemoStore FTS', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-memory-fts-test-'));
    store = new MemoryMemoStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('indexes mixed CJK and ASCII so English words are searchable', async () => {
    await store.append(makeMemo({ userNeed: '修复bug', approach: '使用redis缓存' }));
    const result = await store.list({ search: 'redis' });
    expect(result.total).toBe(1);
  });

  it('indexes individual CJK characters', async () => {
    await store.append(makeMemo({ userNeed: '修复 OAuth 认证bug', approach: '加刷新逻辑' }));
    const result = await store.list({ search: '认证' });
    expect(result.total).toBe(1);
  });

  it('intersects multiple query keywords', async () => {
    await store.append(makeMemo({ userNeed: '修复 OAuth 认证' }));
    await store.append(makeMemo({ userNeed: '修复 TypeScript 配置' }));

    const result = await store.list({ search: '修复 OAuth' });
    expect(result.total).toBe(1);
    expect(result.memos[0]?.userNeed).toContain('OAuth');
  });

  it('keeps the FTS index in sync after delete', async () => {
    const keep = makeMemo({ userNeed: '保留条目', approach: '保留' });
    const remove = makeMemo({ userNeed: '删除条目', approach: '删除' });
    await store.append(keep);
    await store.append(remove);

    await store.delete(remove.id);

    const result = await store.list({ search: '删除' });
    expect(result.total).toBe(0);
  });

  it('migrates existing entries.jsonl into SQLite on first init', async () => {
    const legacy = createMemoryMemo({
      userNeed: 'Legacy need',
      approach: 'Legacy approach',
      outcome: '完成',
      whatFailed: 'none',
      whatWorked: 'none',
      extractionSource: 'exit',
      sourceSessionId: 'legacy-session',
      sourceSessionTitle: 'Legacy Session',
    });

    const memoryDir = join(tmpDir, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, 'entries.jsonl'),
      JSON.stringify({ type: 'memory_memo', version: 2, entry: legacy }) + '\n',
      'utf8',
    );

    const fresh = new MemoryMemoStore(tmpDir);
    const found = await fresh.get(legacy.id);
    expect(found).not.toBeUndefined();
    expect(found!.userNeed).toBe('Legacy need');

    const result = await fresh.list({ search: 'legacy' });
    expect(result.total).toBe(1);
  });

  it('handles concurrent appends without data loss', async () => {
    const a = makeMemo({ userNeed: '并发 A', recordedAt: 1000 });
    const b = makeMemo({ userNeed: '并发 B', recordedAt: 2000 });
    const c = makeMemo({ userNeed: '并发 C', recordedAt: 3000 });
    await Promise.all([store.append(a), store.append(b), store.append(c)]);

    const result = await store.list();
    expect(result.total).toBe(3);
    const needs = new Set(result.memos.map((m) => m.userNeed));
    expect(needs).toContain('并发 A');
    expect(needs).toContain('并发 B');
    expect(needs).toContain('并发 C');
  });

  it('creates the database file after first operation', async () => {
    await store.append(makeMemo());
    const dbPath = join(tmpDir, 'memory', 'memos.sqlite');
    await expect(
      import('node:fs/promises').then((fs) => fs.stat(dbPath)),
    ).resolves.toBeDefined();
  });
});
