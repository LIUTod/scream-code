/**
 * ui-preferences.test.ts — 磁盘读取缓存。
 *
 * `isUserMessageHighlightEnabled` 位于 `UserMessageComponent.render`（引擎每帧
 * 对每个组件调 render），首次读盘后必须命中模块级缓存；`/hl` 切换后必须刷新
 * 缓存，下一次读取直接反映新状态。
 *
 * 读写走真实 fs（数据目录由 test/global-setup.ts 指向每个测试文件独立的临时
 * 目录），只把 `readFileSync` 包一层以统计读盘次数。
 */

import { writeFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getUiPreferencesPath } from '#/tui/utils/ui-preferences';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

describe('ui-preferences disk-read cache', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('reads the file once; later calls are served from the cache', async () => {
    writeFileSync(getUiPreferencesPath(), JSON.stringify({ userMessageHighlightEnabled: true }));
    const fs = await import('node:fs');
    const prefs = await import('#/tui/utils/ui-preferences');
    const readFileSync = vi.mocked(fs.readFileSync);
    // Only reads of the preference file count: unrelated modules in the import
    // graph read other files (e.g. package.json) while loading.
    const prefsReads = (): number =>
      readFileSync.mock.calls.filter(([file]) => String(file) === getUiPreferencesPath()).length;

    expect(prefs.isUserMessageHighlightEnabled()).toBe(true);
    expect(prefsReads()).toBe(1);

    expect(prefs.isUserMessageHighlightEnabled()).toBe(true);
    expect(prefsReads()).toBe(1);
  });

  it('refreshes the cache on toggle, so the next read sees the new state', async () => {
    writeFileSync(getUiPreferencesPath(), '{}');
    const fs = await import('node:fs');
    const prefs = await import('#/tui/utils/ui-preferences');
    const readFileSync = vi.mocked(fs.readFileSync);
    const prefsReads = (): number =>
      readFileSync.mock.calls.filter(([file]) => String(file) === getUiPreferencesPath()).length;

    expect(prefs.isUserMessageHighlightEnabled()).toBe(false); // first disk read
    expect(prefsReads()).toBe(1);

    expect(prefs.toggleUserMessageHighlight()).toBe(true); // reads + writes, refreshes cache
    expect(prefsReads()).toBe(2);

    expect(prefs.isUserMessageHighlightEnabled()).toBe(true); // cache hit, no disk read
    expect(prefsReads()).toBe(2);
  });
});
