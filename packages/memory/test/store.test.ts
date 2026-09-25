import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MemoryMemoStore } from '../src/store.js';
import { createMemoryMemo } from '../src/models.js';
import { buildExitExtractionPrompt, parseMemoryMemos } from '../src/extractor.js';
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

describe('MemoryMemoStore', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-memory-test-'));
    store = new MemoryMemoStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  describe('append / get', () => {
    it('appends and retrieves a memo', async () => {
      const memo = makeMemo();
      await store.append(memo);
      const found = await store.get(memo.id);
      expect(found).not.toBeUndefined();
      expect(found!.userNeed).toBe('Test requirement');
      expect(found!.sourceSessionId).toBe('test-session');
    });

    it('returns undefined for missing memo', async () => {
      expect(await store.get('nonexistent')).toBeUndefined();
    });

    it('stores and retrieves tags', async () => {
      const memo = makeMemo({ tags: ['react', 'auth', '部署'] });
      await store.append(memo);
      const found = await store.get(memo.id);
      expect(found!.tags).toEqual(['react', 'auth', '部署']);
    });

    it('normalizes tags on storage', async () => {
      const memo = makeMemo({ tags: ['React', '  AUTH ', 'auth', '', 'toolongtagname'] });
      await store.append(memo);
      const found = await store.get(memo.id);
      expect(found!.tags).toEqual(['react', 'auth', 'toolongtagname']);
    });

    it('updates tags and persists them', async () => {
      const memo = makeMemo({ tags: ['old'] });
      await store.append(memo);
      await store.update(memo.id, { tags: ['new', 'tag'] });
      const found = await store.get(memo.id);
      expect(found!.tags).toEqual(['new', 'tag']);
    });

    it('updates a memo and reflects the change in search', async () => {
      const memo = makeMemo({ userNeed: 'original need' });
      await store.append(memo);

      const updated = await store.update(memo.id, { userNeed: 'updated need' });
      expect(updated).toBe(true);

      const found = await store.get(memo.id);
      expect(found!.userNeed).toBe('updated need');

      const result = await store.search('updated');
      expect(result.length).toBe(1);

      const oldResult = await store.search('original');
      expect(oldResult.length).toBe(0);
    });

    it('returns false when updating a missing memo', async () => {
      expect(await store.update('nonexistent', { userNeed: 'x' })).toBe(false);
    });
  });

  describe('init', () => {
    it('throws when init fails and does not mark initialized', async () => {
      const badPath = join(tmpDir, 'existing-file');
      await writeFile(badPath, 'x', 'utf8');
      const badStore = new MemoryMemoStore(badPath);
      await expect(badStore.init()).rejects.toThrow();
      await expect(badStore.init()).rejects.toThrow();
    });
  });

  describe('delete', () => {
    it('deletes a memo', async () => {
      const memo = makeMemo();
      await store.append(memo);
      expect(await store.delete(memo.id)).toBe(true);
      expect(await store.get(memo.id)).toBeUndefined();
    });

    it('handles delete of nonexistent id gracefully', async () => {
      // Delete on an empty store succeeds (nothing to remove)
      expect(await store.delete('no-such-id')).toBe(true);
    });
  });

  describe('list', () => {
    it('lists all memos sorted by recordedAt desc', async () => {
      const older = makeMemo({ recordedAt: 1000 });
      const newer = makeMemo({ recordedAt: 2000 });
      await store.append(older);
      await store.append(newer);

      const result = await store.list();
      expect(result.total).toBe(2);
      expect(result.memos[0]!.recordedAt).toBe(2000);
      expect(result.memos[1]!.recordedAt).toBe(1000);
    });

    it('respects limit', async () => {
      for (let i = 0; i < 10; i++) {
        await store.append(makeMemo());
      }
      const result = await store.list({ limit: 3 });
      expect(result.memos.length).toBe(3);
      expect(result.total).toBe(10);
    });

    it('filters by search keyword', async () => {
      await store.append(makeMemo({ userNeed: '修复 OAuth 认证bug', approach: '加刷新逻辑' }));
      await store.append(makeMemo({ userNeed: '配置 TypeScript', approach: '改 tsconfig' }));
      await store.append(makeMemo({ userNeed: '优化性能', approach: '加缓存' }));

      const result = await store.list({ search: 'oauth' });
      expect(result.total).toBe(1);
      expect(result.memos[0]!.userNeed).toContain('OAuth');
    });

    it('searches across approach field', async () => {
      await store.append(makeMemo({ userNeed: '修复bug', approach: '使用redis缓存' }));
      const result = await store.list({ search: 'redis' });
      expect(result.total).toBe(1);
    });
  });

  describe('read (iteration)', () => {
    it('yields all entries', async () => {
      await store.append(makeMemo());
      await store.append(makeMemo());

      const entries: MemoryMemo[] = [];
      for await (const memo of store.read()) {
        entries.push(memo);
      }
      expect(entries.length).toBe(2);
    });
  });

  describe('search', () => {
    it('recalls memos by keyword across fields', async () => {
      await store.append(makeMemo({ userNeed: '修复 OAuth 认证', approach: '加刷新逻辑' }));
      await store.append(makeMemo({ userNeed: '配置 TypeScript', approach: '改 tsconfig' }));

      const result = await store.search('oauth');
      expect(result.length).toBe(1);
      expect(result[0]!.userNeed).toContain('OAuth');
    });

    it('recalls mixed CJK/ASCII queries', async () => {
      await store.append(makeMemo({ userNeed: '修复bug', approach: '使用redis缓存' }));

      const result = await store.search('redis');
      expect(result.length).toBe(1);
      expect(result[0]!.approach).toContain('redis');
    });

    it('recalls individual CJK characters', async () => {
      await store.append(makeMemo({ userNeed: '修复 OAuth 认证bug', approach: '加刷新逻辑' }));

      const result = await store.search('认证');
      expect(result.length).toBe(1);
    });

    it('intersects multiple keywords', async () => {
      await store.append(makeMemo({ userNeed: '修复 OAuth 认证' }));
      await store.append(makeMemo({ userNeed: '修复 TypeScript 配置' }));

      const result = await store.search('修复 OAuth');
      expect(result.length).toBe(1);
      expect(result[0]!.userNeed).toContain('OAuth');
    });

    it('searches across tags', async () => {
      await store.append(makeMemo({ userNeed: 'fix bug', approach: 'change config', tags: ['redis'] }));
      const result = await store.list({ search: 'redis' });
      expect(result.total).toBe(1);
    });

    it('respects candidateLimit', async () => {
      for (let i = 0; i < 10; i++) {
        await store.append(makeMemo({ userNeed: `task ${i} shared keyword` }));
      }

      const result = await store.search('shared keyword', { candidateLimit: 3 });
      expect(result.length).toBe(3);
    });

    it('returns an empty array for empty or whitespace queries', async () => {
      await store.append(makeMemo({ userNeed: 'something' }));

      expect(await store.search('')).toEqual([]);
      expect(await store.search('   ')).toEqual([]);
    });

    it('filters by projectDir and includes legacy empty projectDir', async () => {
      await store.append(
        makeMemo({ userNeed: 'project A need', projectDir: '/workspace/a', recordedAt: 1000 }),
      );
      await store.append(
        makeMemo({ userNeed: 'project B need', projectDir: '/workspace/b', recordedAt: 2000 }),
      );
      await store.append(makeMemo({ userNeed: 'legacy need', projectDir: '', recordedAt: 3000 }));

      const aResult = await store.search('need', { projectDir: '/workspace/a' });
      expect(aResult.map((m) => m.userNeed)).toEqual(['legacy need', 'project A need']);

      const bResult = await store.list({ search: 'need', projectDir: '/workspace/b' });
      expect(bResult.memos.map((m) => m.userNeed)).toEqual(['legacy need', 'project B need']);

      const all = [];
      for await (const memo of store.read({ projectDir: '/workspace/a' })) {
        all.push(memo);
      }
      expect(all.map((m) => m.userNeed)).toEqual(['legacy need', 'project A need']);
    });
  });
});

describe('migrateLegacyStores', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-memory-migration-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('migrates per-session entries to the global store and deletes legacy files', async () => {
    const legacyMemo = createMemoryMemo({
      userNeed: 'Legacy need',
      approach: 'Legacy approach',
      outcome: '完成',
      whatFailed: 'none',
      whatWorked: 'none',
      extractionSource: 'exit',
      sourceSessionId: 'legacy-session',
      sourceSessionTitle: 'Legacy Session',
    });

    const legacyDir = join(tmpDir, 'sessions', 'wd_abc123', 'memory');
    await mkdir(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, 'entries.jsonl');
    await writeFile(
      legacyPath,
      JSON.stringify({ type: 'memory_memo', version: 2, entry: legacyMemo }) + '\n',
      'utf8',
    );

    await MemoryMemoStore.migrateLegacyStores(tmpDir);

    const globalStore = new MemoryMemoStore(tmpDir);
    const memos: MemoryMemo[] = [];
    for await (const memo of globalStore.read()) {
      memos.push(memo);
    }
    expect(memos.length).toBe(1);
    expect(memos[0]!.userNeed).toBe('Legacy need');

    await expect(stat(legacyPath)).rejects.toThrow();
  });

  it('skips entries whose ids already exist in the global store', async () => {
    const sharedMemo = createMemoryMemo({
      userNeed: 'Shared need',
      approach: 'Shared approach',
      outcome: '完成',
      whatFailed: 'none',
      whatWorked: 'none',
      extractionSource: 'exit',
      sourceSessionId: 'shared-session',
      sourceSessionTitle: 'Shared Session',
    });

    const globalStore = new MemoryMemoStore(tmpDir);
    await globalStore.append(sharedMemo);

    const legacyDir = join(tmpDir, 'sessions', 'wd_shared', 'memory');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, 'entries.jsonl'),
      JSON.stringify({ type: 'memory_memo', version: 2, entry: sharedMemo }) + '\n',
      'utf8',
    );

    await MemoryMemoStore.migrateLegacyStores(tmpDir);

    const memos: MemoryMemo[] = [];
    for await (const memo of globalStore.read()) {
      memos.push(memo);
    }
    expect(memos.length).toBe(1);
  });
});

describe('parseMemoryMemos', () => {
  it('parses valid memory-memo blocks', () => {
    const text = `
## Current Focus
Working on auth module

\`\`\`memory-memo
{
  "userNeed": "修复 OAuth 401",
  "approach": "增加 token 刷新重试",
  "outcome": "完成",
  "whatFailed": "无限重试导致死循环，加了 max retries",
  "whatWorked": "加了 max retries 限制"
}
\`\`\`

\`\`\`memory-memo
{
  "userNeed": "优化编译速度",
  "approach": "升级 tsdown，启用并行编译",
  "outcome": "部分完成",
  "whatFailed": "none",
  "whatWorked": "none"
}
\`\`\`
`;

    const memos = parseMemoryMemos(text);
    expect(memos.length).toBe(2);
    expect(memos[0]!.userNeed).toContain('OAuth');
    expect(memos[0]!.outcome).toBe('完成');
    expect(memos[1]!.outcome).toBe('部分完成');
  });

  it('returns empty for {"none": true}', () => {
    const text = '```memory-memo\n{"none": true}\n```';
    expect(parseMemoryMemos(text).length).toBe(0);
  });

  it('skips malformed JSON blocks', () => {
    const text = '```memory-memo\n{not valid json}\n```';
    expect(parseMemoryMemos(text).length).toBe(0);
  });

  it('skips blocks without userNeed', () => {
    const text = '```memory-memo\n{"approach": "something"}\n```';
    expect(parseMemoryMemos(text).length).toBe(0);
  });

  it('parses blocks with all new fields', () => {
    const text = '```memory-memo\n{"userNeed": "test", "approach": "x", "outcome": "完成", "whatFailed": "试了A不行", "whatWorked": "方案B成功"}\n```';
    const memos = parseMemoryMemos(text);
    expect(memos[0]!.whatFailed).toBe('试了A不行');
    expect(memos[0]!.whatWorked).toBe('方案B成功');
  });

  it('parses tags from memory-memo blocks', () => {
    const text = '```memory-memo\n{"userNeed": "fix auth", "approach": "x", "outcome": "完成", "tags": ["React", "auth"]}\n```';
    const memos = parseMemoryMemos(text);
    expect(memos[0]!.tags).toEqual(['react', 'auth']);
  });

  it('falls back to empty tags when tags field is missing', () => {
    const text = '```memory-memo\n{"userNeed": "test", "approach": "x", "outcome": "完成"}\n```';
    const memos = parseMemoryMemos(text);
    expect(memos[0]!.tags).toBeUndefined();
  });
});

describe('buildExitExtractionPrompt', () => {
  it('includes the sample text in the prompt (Chinese)', () => {
    const prompt = buildExitExtractionPrompt('sess-123', 50, '[user] fix the bug\n[assistant] done');
    expect(prompt).toContain('sess-123');
    expect(prompt).toContain('50');
    expect(prompt).toContain('[user] fix the bug');
    expect(prompt).toContain('[assistant] done');
    expect(prompt).toContain('已完成的任务闭环');
    expect(prompt).toContain('对话记录');
  });
});
