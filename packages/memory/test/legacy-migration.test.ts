import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { createMemoryMemo } from '../src/models.js';
import { MemoryMemoStore } from '../src/store.js';

let tmpDir = '';

afterEach(async () => {
  if (tmpDir.length > 0) await rm(tmpDir, { recursive: true, force: true });
});

/** Schema as it existed before `origin` / `distilled_from` / `distilled_at`. */
function createPreOriginSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE memos (
      id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL,
      source_session_title TEXT,
      user_need TEXT NOT NULL,
      approach TEXT NOT NULL,
      outcome TEXT NOT NULL,
      what_failed TEXT NOT NULL DEFAULT 'none',
      what_worked TEXT NOT NULL DEFAULT 'none',
      extraction_source TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      project_dir TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      note TEXT,
      distilled TEXT NOT NULL DEFAULT ''
    )
  `);
}

function insertPreOriginRow(
  db: DatabaseSync,
  id: string,
  userNeed: string,
  distilled: string,
): void {
  db.prepare(
    `INSERT INTO memos (
      id, source_session_id, source_session_title, user_need, approach,
      outcome, what_failed, what_worked, extraction_source, recorded_at,
      project_dir, tags, note, distilled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    'session-1',
    'Legacy',
    userNeed,
    'legacy approach',
    '完成',
    'none',
    'none',
    'compaction',
    Date.now(),
    '',
    '[]',
    null,
    distilled,
  );
}

describe('legacy store migration', () => {
  it('adds distilled to a memos table created before the field existed', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-legacy-'));
    await mkdir(join(tmpDir, 'memory'), { recursive: true });
    const db = new DatabaseSync(join(tmpDir, 'memory', 'memos.sqlite'));
    db.exec(`
      CREATE TABLE memos (
        id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL,
        source_session_title TEXT,
        user_need TEXT NOT NULL,
        approach TEXT NOT NULL,
        outcome TEXT NOT NULL,
        what_failed TEXT NOT NULL DEFAULT 'none',
        what_worked TEXT NOT NULL DEFAULT 'none',
        extraction_source TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]'
      )
    `);
    db.prepare(
      `INSERT INTO memos (
        id, source_session_id, source_session_title, user_need, approach,
        outcome, what_failed, what_worked, extraction_source, recorded_at, project_dir, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'legacy-1',
      'session-1',
      'Legacy',
      'legacy need',
      'legacy approach',
      '完成',
      'none',
      'none',
      'compaction',
      Date.now(),
      '',
      '[]',
    );
    db.close();

    const store = new MemoryMemoStore(tmpDir);
    await store.init();

    const legacy = await store.get('legacy-1');
    expect(legacy?.userNeed).toBe('legacy need');
    expect(legacy?.distilled).toBeUndefined();
    // No distilled text existed, so the origin backfill must not touch it.
    expect(legacy?.origin).toBe('session');

    const fresh = createMemoryMemo({
      userNeed: 'fresh need',
      approach: 'fresh approach',
      outcome: '完成',
      whatFailed: 'none',
      whatWorked: 'none',
      extractionSource: 'compaction',
      sourceSessionId: 'session-2',
      distilled: '新写入的归纳结论',
    });
    await store.append(fresh);
    expect((await store.get(fresh.id))?.distilled).toBe('新写入的归纳结论');

    const found = await store.list({ search: '归纳结论' });
    expect(found.memos.map((memo) => memo.id)).toContain(fresh.id);
  });

  it('adds the provenance columns and backfills existing conclusions to dream', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-legacy-origin-'));
    await mkdir(join(tmpDir, 'memory'), { recursive: true });
    const db = new DatabaseSync(join(tmpDir, 'memory', 'memos.sqlite'));
    createPreOriginSchema(db);
    insertPreOriginRow(db, 'legacy-rule', '旧需求', '旧结论');
    insertPreOriginRow(db, 'legacy-plain', '旧经历', '');
    db.close();

    const store = new MemoryMemoStore(tmpDir);
    await store.init();

    const rule = await store.get('legacy-rule');
    expect(rule?.origin).toBe('dream');
    expect(rule?.distilled).toBe('旧结论');
    expect(rule?.distilledFrom).toBeUndefined();
    expect(rule?.distilledAt).toBeUndefined();

    const plain = await store.get('legacy-plain');
    expect(plain?.origin).toBe('session');
  });
});
