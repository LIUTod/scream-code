import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MemoryMemoStore } from '../src/store.js';
import { createMemoryMemo } from '../src/models.js';
import { buildExitExtractionPrompt, parseMemoryMemos } from '../src/extractor.js';
import type { MemoryMemo } from '../src/models.js';

function makeMemo(overrides: Partial<MemoryMemo> = {}): MemoryMemo {
  return createMemoryMemo({
    userRequirement: 'Test requirement',
    solution: 'Test solution',
    completionStatus: 'done',
    problemsEncountered: 'none',
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
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('append / get', () => {
    it('appends and retrieves a memo', async () => {
      const memo = makeMemo();
      await store.append(memo);
      const found = await store.get(memo.id);
      expect(found).not.toBeUndefined();
      expect(found!.userRequirement).toBe('Test requirement');
      expect(found!.sourceSessionId).toBe('test-session');
    });

    it('returns undefined for missing memo', async () => {
      expect(await store.get('nonexistent')).toBeUndefined();
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
      await store.append(makeMemo({ userRequirement: '修复 OAuth 认证bug', solution: '加刷新逻辑' }));
      await store.append(makeMemo({ userRequirement: '配置 TypeScript', solution: '改 tsconfig' }));
      await store.append(makeMemo({ userRequirement: '优化性能', solution: '加缓存' }));

      const result = await store.list({ search: 'oauth' });
      expect(result.total).toBe(1);
      expect(result.memos[0]!.userRequirement).toContain('OAuth');
    });

    it('searches across solution field', async () => {
      await store.append(makeMemo({ userRequirement: '修复bug', solution: '使用redis缓存' }));
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
});

describe('parseMemoryMemos', () => {
  it('parses valid memory-memo blocks', () => {
    const text = `
## Current Focus
Working on auth module

\`\`\`memory-memo
{
  "userRequirement": "修复 OAuth 401",
  "solution": "增加 token 刷新重试",
  "completionStatus": "done",
  "problemsEncountered": "无限重试导致死循环，加了 max retries"
}
\`\`\`

\`\`\`memory-memo
{
  "userRequirement": "优化编译速度",
  "solution": "升级 tsdown，启用并行编译",
  "completionStatus": "partially done",
  "problemsEncountered": "none"
}
\`\`\`
`;

    const memos = parseMemoryMemos(text);
    expect(memos.length).toBe(2);
    expect(memos[0]!.userRequirement).toContain('OAuth');
    expect(memos[0]!.completionStatus).toBe('done');
    expect(memos[1]!.completionStatus).toBe('partially done');
  });

  it('returns empty for {"none": true}', () => {
    const text = '\`\`\`memory-memo\n{"none": true}\n\`\`\`';
    expect(parseMemoryMemos(text).length).toBe(0);
  });

  it('skips malformed JSON blocks', () => {
    const text = '\`\`\`memory-memo\n{not valid json}\n\`\`\`';
    expect(parseMemoryMemos(text).length).toBe(0);
  });

  it('skips blocks without userRequirement', () => {
    const text = '\`\`\`memory-memo\n{"solution": "something"}\n\`\`\`';
    expect(parseMemoryMemos(text).length).toBe(0);
  });

  it('normalizes completion status values', () => {
    const text = '\`\`\`memory-memo\n{"userRequirement": "test", "solution": "x", "completionStatus": "completed", "problemsEncountered": "none"}\n\`\`\`';
    const memos = parseMemoryMemos(text);
    expect(memos[0]!.completionStatus).toBe('done');
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
