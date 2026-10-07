import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MemoryMemoStore, closeSharedMemoStore, sharedMemoStore } from '../src/store.js';
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

describe('sharedMemoStore', () => {
  let tmpDir: string;
  let otherDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-shared-memo-a-'));
    otherDir = await mkdtemp(join(tmpdir(), 'scream-shared-memo-b-'));
  });

  afterEach(async () => {
    // Reset global state first so lingering spies never observe the cleanup
    // closes — each test asserts on exactly the calls it triggered itself.
    vi.restoreAllMocks();
    closeSharedMemoStore(tmpDir);
    closeSharedMemoStore(otherDir);
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    await rm(otherDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('returns the same instance for one home directory and distinct instances across homes', () => {
    const first = sharedMemoStore(tmpDir);
    const second = sharedMemoStore(tmpDir);
    const other = sharedMemoStore(otherDir);

    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });

  it('closeSharedMemoStore closes the cached instance and the next lookup builds a new one', () => {
    const first = sharedMemoStore(tmpDir);
    const closeSpy = vi.spyOn(first, 'close');

    closeSharedMemoStore(tmpDir);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    const second = sharedMemoStore(tmpDir);
    expect(second).not.toBe(first);
    closeSpy.mockRestore();
  });

  it('opens the database once across repeated lookups and init calls', async () => {
    type InitCapable = { _doInit(): Promise<void> };
    const doInitSpy = vi.spyOn(
      MemoryMemoStore.prototype as unknown as InitCapable,
      '_doInit',
    );

    for (let i = 0; i < 10; i += 1) {
      const store = sharedMemoStore(tmpDir);
      await store.init();
    }

    // Ten lookups plus ten init() calls resolve to one shared instance, so the
    // underlying open runs exactly once. Handing out a fresh store per call
    // would open ten times and fail here.
    expect(doInitSpy).toHaveBeenCalledTimes(1);
    doInitSpy.mockRestore();
  });
});

describe('migrateLegacyStores temporary-store lifecycle', () => {
  let tmpDir: string;
  let otherDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-shared-memo-mig-a-'));
    otherDir = await mkdtemp(join(tmpdir(), 'scream-shared-memo-mig-b-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    await rm(otherDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('closes each temporary store exactly once, matching its construction count', async () => {
    const closed: MemoryMemoStore[] = [];
    const originalClose = MemoryMemoStore.prototype.close;
    vi.spyOn(MemoryMemoStore.prototype, 'close').mockImplementation(function (
      this: MemoryMemoStore,
    ): void {
      closed.push(this);
      originalClose.call(this);
    });

    // Path 1: no sessions directory — the readdir catch swallows and returns
    // early, but still constructs (and must close) a temporary store.
    await mkdir(join(tmpDir, 'memory'), { recursive: true });
    await MemoryMemoStore.migrateLegacyStores(tmpDir);

    // Path 2: migration marker already present — the stat hit returns early,
    // again after constructing a temporary store.
    await MemoryMemoStore.migrateLegacyStores(tmpDir);

    // Path 3: real legacy per-session entries — the full migration, including
    // the per-file swallow branch, must close too.
    const legacyDir = join(otherDir, 'sessions', 'wd_abc123', 'memory');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, 'entries.jsonl'),
      JSON.stringify({ type: 'memory_memo', version: 2, entry: makeMemo() }) + '\n',
      'utf8',
    );
    await MemoryMemoStore.migrateLegacyStores(otherDir);

    // Each migrateLegacyStores invocation constructs exactly one temporary
    // store (the sole `new MemoryMemoStore` inside it) — three invocations →
    // three constructions, so three closes on three distinct instances. Drop
    // the try/finally and this count collapses to zero.
    expect(closed).toHaveLength(3);
    expect(new Set(closed).size).toBe(3);
  });
});
