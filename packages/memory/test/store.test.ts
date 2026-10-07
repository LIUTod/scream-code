import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { MemoryMemoStore } from '../src/store.js';
import { createMemoryMemo } from '../src/models.js';
import { buildExitExtractionPrompt, parseMemoryMemos } from '../src/extractor.js';
import type { MemoryMemo } from '../src/models.js';

/** Must match READ_BATCH_SIZE in src/store.ts (pinned here so the paging probe stays discriminative). */
const PAGE_SIZE = 500;

interface RecordedSqlCall {
  sql: string;
  args: unknown[];
  rowCount: number;
  /** Last row of the batch — the keyset cursor the next page must resume from. */
  lastRow: Record<string, unknown> | undefined;
}

/**
 * Record every `prepare(...).all(...)` issued by the store's db handle.
 * Used to prove read() pages with a bounded keyset cursor: a revert to
 * full-materialization (`stmt.all()` with no LIMIT) or to LIMIT/OFFSET paging
 * turns the assertions red.
 */
function spyOnSelects(store: MemoryMemoStore): {
  calls: RecordedSqlCall[];
  restore: () => void;
} {
  const calls: RecordedSqlCall[] = [];
  const db = (store as unknown as { db: DatabaseSync }).db;
  const origPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const stmt = origPrepare(sql);
    const origAll = stmt.all.bind(stmt) as (...args: unknown[]) => unknown[];
    stmt.all = ((...args: unknown[]) => {
      const rows = origAll(...args);
      calls.push({
        sql,
        args,
        rowCount: rows.length,
        lastRow: rows.at(-1) as Record<string, unknown> | undefined,
      });
      return rows;
    }) as typeof stmt.all;
    return stmt;
  }) as typeof db.prepare;
  return {
    calls,
    restore: () => {
      db.prepare = origPrepare;
    },
  };
}

/** read()'s paging SELECTs — the only memo SELECTs that carry a LIMIT. */
function memoPageCalls(spy: { calls: RecordedSqlCall[] }): RecordedSqlCall[] {
  return spy.calls.filter((c) => c.sql.includes('FROM memos') && c.sql.includes('LIMIT'));
}

/** The keyset predicate every page after the first must carry. */
const KEYSET_PREDICATE = 'recorded_at < ?1 OR (recorded_at = ?1 AND rowid < ?2)';

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

    it('yields nothing for an empty store', async () => {
      const entries: MemoryMemo[] = [];
      for await (const memo of store.read()) {
        entries.push(memo);
      }
      expect(entries).toEqual([]);
    });

    it('reads a 5050-row store back byte-for-byte across batch boundaries', async () => {
      // 5050 = 10 full pages of 500 + one partial page of 50.
      const written: MemoryMemo[] = [];
      for (let i = 0; i < 5050; i++) {
        const memo = makeMemo({
          id: `memo-bulk-${i}`,
          sourceSessionId: `sess-${i}`,
          sourceSessionTitle: `会话 ${i} · title-'x'`,
          userNeed: `需要 ${i}\n第二行\t制表 "引号" '单引号' \\反斜杠 🚀`,
          approach: `方案 ${i} — mixed ASCII/CJK`,
          outcome: i % 2 === 0 ? '完成' : '部分完成',
          whatFailed: `失败面 ${i} ${'f'.repeat(i % 17)}`,
          whatWorked: `成功面 ${i} ${'w'.repeat(i % 23)}`,
          recordedAt: 1_700_000_000_000 + i,
          projectDir: i % 3 === 0 ? '' : '/workspace/proj',
          tags: [`tag-${i % 7}`, '共通'],
        });
        await store.append(memo);
        written.push(memo);
      }

      const seen: MemoryMemo[] = [];
      for await (const memo of store.read()) {
        seen.push(memo);
      }
      expect(seen.length).toBe(5050);
      // Byte-for-byte field equality against what was written (order:
      // recorded_at DESC with unique timestamps → exact reverse of insertion).
      for (let i = 0; i < written.length; i++) {
        const expected = written[written.length - 1 - i]!;
        expect(seen[i]).toEqual(expected);
      }
    }, 60_000);

    it('pages exactly when the row count divides the batch size evenly', async () => {
      // 1000 rows = exactly 2 pages of 500.
      for (let i = 0; i < 1000; i++) {
        await store.append(makeMemo({ id: `memo-exact-${i}`, recordedAt: 1000 + i }));
      }
      const spy = spyOnSelects(store);
      try {
        const seen: MemoryMemo[] = [];
        for await (const memo of store.read()) {
          seen.push(memo);
        }
        expect(seen.length).toBe(1000);
        expect(seen.map((m) => m.id)).toEqual(
          Array.from({ length: 1000 }, (_, k) => `memo-exact-${999 - k}`),
        );

        const pageCalls = memoPageCalls(spy);
        // 2 full pages + 1 terminating empty page probe.
        expect(pageCalls.length).toBe(3);
        for (const call of pageCalls) {
          expect(call.sql).toContain('ORDER BY recorded_at DESC, rowid DESC');
          expect(call.sql).not.toContain('OFFSET');
        }
        // Page 1 has no cursor; every later page seeks from the previous page's
        // last row and is bounded by PAGE_SIZE.
        expect(pageCalls[0]!.sql).not.toContain('recorded_at <');
        expect(pageCalls[0]!.args).toEqual([PAGE_SIZE]);
        for (let k = 1; k < pageCalls.length; k++) {
          const call = pageCalls[k]!;
          expect(call.sql).toContain(KEYSET_PREDICATE);
          const previousLastRow = pageCalls[k - 1]!.lastRow!;
          expect(call.args).toEqual([
            previousLastRow['recorded_at'],
            previousLastRow['row_id'],
            PAGE_SIZE,
          ]);
        }
      } finally {
        spy.restore();
      }
    }, 30_000);

    it('pages with a short final batch when the row count does not divide evenly', async () => {
      // 1250 rows = 2 full pages of 500 + one short page of 250.
      for (let i = 0; i < 1250; i++) {
        await store.append(makeMemo({ id: `memo-uneven-${i}`, recordedAt: 2000 + i }));
      }
      const spy = spyOnSelects(store);
      try {
        const seen: MemoryMemo[] = [];
        for await (const memo of store.read()) {
          seen.push(memo);
        }
        expect(seen.length).toBe(1250);
        expect(seen.map((m) => m.id)).toEqual(
          Array.from({ length: 1250 }, (_, k) => `memo-uneven-${1249 - k}`),
        );

        const pageCalls = memoPageCalls(spy);
        expect(pageCalls.length).toBe(3);
        expect(pageCalls.map((c) => c.rowCount)).toEqual([500, 500, 250]);
        expect(pageCalls[0]!.args).toEqual([PAGE_SIZE]);
        for (let k = 1; k < pageCalls.length; k++) {
          const previousLastRow = pageCalls[k - 1]!.lastRow!;
          expect(pageCalls[k]!.args).toEqual([
            previousLastRow['recorded_at'],
            previousLastRow['row_id'],
            PAGE_SIZE,
          ]);
        }
      } finally {
        spy.restore();
      }
    }, 30_000);

    it('breaks recorded_at ties by rowid DESC so page boundaries are stable', async () => {
      // Same timestamp for every row: order must still be total (newest insert
      // first), so the keyset cursor is a strict seek and pages cannot skip or
      // repeat rows.
      for (let i = 0; i < 5; i++) {
        await store.append(makeMemo({ id: `memo-tie-${i}`, recordedAt: 42 }));
      }
      const seen: MemoryMemo[] = [];
      for await (const memo of store.read()) {
        seen.push(memo);
      }
      expect(seen.map((m) => m.id)).toEqual([
        'memo-tie-4',
        'memo-tie-3',
        'memo-tie-2',
        'memo-tie-1',
        'memo-tie-0',
      ]);
    });

    it('revert-red: a non-paged read() fails the SQL batch probe', async () => {
      // Guards against silently reintroducing stmt.all() full materialization
      // or LIMIT/OFFSET paging: the probe asserts one bounded keyset seek per
      // page, each resuming from the previous page's last row.
      for (let i = 0; i < 600; i++) {
        await store.append(makeMemo({ id: `memo-probe-${i}`, recordedAt: 3000 + i }));
      }
      const spy = spyOnSelects(store);
      try {
        const seen: MemoryMemo[] = [];
        for await (const memo of store.read()) {
          seen.push(memo);
        }
        expect(seen.length).toBe(600);

        const pageCalls = memoPageCalls(spy);
        // Pagination must actually happen: 500 + 100, never a single
        // unbounded materialization and never an OFFSET-shifted window.
        expect(pageCalls.length).toBe(2);
        for (const call of pageCalls) {
          expect(call.sql).toContain('ORDER BY recorded_at DESC, rowid DESC');
          expect(call.sql).not.toContain('OFFSET');
          expect(call.rowCount).toBeLessThanOrEqual(PAGE_SIZE);
        }
        expect(pageCalls[0]!.rowCount).toBe(PAGE_SIZE);
        expect(pageCalls[0]!.args).toEqual([PAGE_SIZE]);
        const second = pageCalls[1]!;
        expect(second.sql).toContain(KEYSET_PREDICATE);
        expect(second.args).toEqual([
          pageCalls[0]!.lastRow!['recorded_at'],
          pageCalls[0]!.lastRow!['row_id'],
          PAGE_SIZE,
        ]);
        expect(second.rowCount).toBe(100);
      } finally {
        spy.restore();
      }
    }, 30_000);

    it('keeps the snapshot stable when an append lands between two pages', async () => {
      const total = 1000;
      for (let i = 0; i < total; i++) {
        await store.append(makeMemo({ id: `memo-snap-${i}`, recordedAt: 1000 + i }));
      }
      const injected = makeMemo({ id: 'memo-snap-injected', recordedAt: 1_000_000 });

      const seen: string[] = [];
      for await (const memo of store.read()) {
        seen.push(memo.id);
        // Page boundary: the generator has yielded the last row of a full page
        // and is parked before its next query, so this append — a newer
        // recorded_at, i.e. a row above the cursor — lands exactly between
        // page 1 and page 2. Under OFFSET paging it would shift the window
        // down and repeat this page's last row on the next one.
        if (seen.length === PAGE_SIZE) await store.append(injected);
      }

      // No row was yielded twice...
      expect(new Set(seen).size).toBe(seen.length);
      // ...and the snapshot still holds every row that existed when it began,
      // in order — the append neither duplicated nor displaced anything.
      expect(seen).toEqual(Array.from({ length: total }, (_, k) => `memo-snap-${total - 1 - k}`));

      // The appended memo sorts above the cursor, so the snapshot simply does
      // not include it — comparing against the final store proves nothing else
      // went missing.
      const finalIds: string[] = [];
      for await (const memo of store.read()) finalIds.push(memo.id);
      expect(finalIds.length).toBe(total + 1);
      expect(new Set(finalIds)).toEqual(new Set([...seen, injected.id]));
    }, 30_000);

    it('keeps the snapshot stable when a delete lands between two pages', async () => {
      const total = 1000;
      for (let i = 0; i < total; i++) {
        await store.append(makeMemo({ id: `memo-gone-${i}`, recordedAt: 1000 + i }));
      }

      const seen: string[] = [];
      for await (const memo of store.read()) {
        seen.push(memo.id);
        // Delete the newest row — already yielded — at the page boundary.
        // Under OFFSET paging the window would shift up and pull one
        // not-yet-yielded row past it; a keyset cursor is unaffected.
        if (seen.length === PAGE_SIZE) await store.delete(`memo-gone-${total - 1}`);
      }

      expect(new Set(seen).size).toBe(total);
      expect(seen).toEqual(Array.from({ length: total }, (_, k) => `memo-gone-${total - 1 - k}`));
    }, 30_000);
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
