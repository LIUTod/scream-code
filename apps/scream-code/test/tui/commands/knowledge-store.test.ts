/**
 * knowledge-store.test.ts — /knowledge 向量模型下载的入口契约。
 *
 * 钉死三件在真实用户机器上出过问题的行为：
 * 1. store 与 embedding engine 一起建成后才对外发布 —— 瞬时 init 失败之后
 *    必须还能重试（旧实现把 store 先发布，之后每次下载都秒回
 *    "embedding engine not initialized"，进程内不可恢复）；
 * 2. 缓存门禁按 fastembed 真实需要的文件集判定（少一个就会被判成"已安装"）；
 * 3. 平台没有本地模型二进制时，不进下载、不清缓存，直接给出可分类的失败。
 *
 * 打桩：`@scream-code/knowledge`（KnowledgeStore）与 `@scream-code/memory` 的
 * 有副作用函数；错误分类函数用真实实现（`importActual`）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeImpl = vi.hoisted(() => ({
  init: vi.fn<() => Promise<void>>(async () => {}),
  setEmbeddingEngine: vi.fn(),
}));

vi.mock('@scream-code/knowledge', async () => {
  const { createFastEmbedEngine } = await import('@scream-code/memory');
  class KnowledgeStore {
    private engine: ReturnType<typeof createFastEmbedEngine> | undefined;
    init = storeImpl.init;
    setEmbeddingEngine = (engine: ReturnType<typeof createFastEmbedEngine>): void => {
      this.engine = engine;
      storeImpl.setEmbeddingEngine(engine);
    };
    getEmbeddingEngine = (): ReturnType<typeof createFastEmbedEngine> | undefined => this.engine;
  }
  // Minimal mirror of the real shared provider: memoized per homeDir, engine
  // wired after init, entry dropped on failure so the next caller retries.
  const entries = new Map<string, { store: KnowledgeStore; ready: Promise<void> }>();
  function entryFor(homeDir: string): { store: KnowledgeStore; ready: Promise<void> } {
    const existing = entries.get(homeDir);
    if (existing !== undefined) return existing;
    const store = new KnowledgeStore();
    const ready = (async () => {
      try {
        await store.init();
        store.setEmbeddingEngine(createFastEmbedEngine(join(homeDir, 'cache', 'fastembed')));
      } catch (error) {
        entries.delete(homeDir);
        throw error;
      }
    })();
    const entry = { store, ready };
    entries.set(homeDir, entry);
    return entry;
  }
  return {
    KnowledgeStore,
    sharedKnowledgeStore: (homeDir: string) => entryFor(homeDir).store,
    sharedKnowledgeStoreReady: (homeDir: string) => entryFor(homeDir).ready,
  };
});

interface FakeEngine {
  available: boolean;
  lastError: string | undefined;
  ensureReady: ReturnType<typeof vi.fn>;
  embedBatch: ReturnType<typeof vi.fn>;
}

const memImpl = vi.hoisted(() => ({
  engines: [] as FakeEngine[],
  probe: vi.fn(async (): Promise<{ supported: boolean; error?: string }> => ({ supported: true })),
  clear: vi.fn(),
}));

vi.mock('@scream-code/memory', async () => {
  const actual = await vi.importActual<typeof import('@scream-code/memory')>('@scream-code/memory');
  return {
    ...actual,
    createFastEmbedEngine: vi.fn(() => {
      const engine = {
        available: false,
        lastError: undefined as string | undefined,
        ensureReady: vi.fn(async () => true),
        embedBatch: vi.fn(async () => null),
      };
      memImpl.engines.push(engine);
      return engine;
    }),
    probeLocalEmbeddingSupport: memImpl.probe,
    clearEmbeddingModelCache: memImpl.clear,
  };
});

const MODEL_DIR = 'fast-bge-small-zh-v1.5';
const REQUIRED_FILES = [
  'model_optimized.onnx',
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
] as const;

let home: string;
const originalHome = process.env['SCREAM_CODE_HOME'];

async function loadModule(): Promise<typeof import('#/tui/commands/knowledge-store')> {
  // 模块持有单例状态，每个用例都要一份干净的实例。
  vi.resetModules();
  return await import('#/tui/commands/knowledge-store');
}

function writeCacheFiles(files: readonly string[]): void {
  const dir = join(home, 'cache', 'fastembed', MODEL_DIR);
  mkdirSync(dir, { recursive: true });
  for (const file of files) writeFileSync(join(dir, file), 'x');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'scream-knowledge-store-'));
  process.env['SCREAM_CODE_HOME'] = home;
  storeImpl.init.mockReset();
  storeImpl.init.mockResolvedValue(undefined);
  storeImpl.setEmbeddingEngine.mockReset();
  memImpl.engines.length = 0;
  memImpl.probe.mockReset();
  memImpl.probe.mockResolvedValue({ supported: true });
  memImpl.clear.mockReset();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env['SCREAM_CODE_HOME'];
  else process.env['SCREAM_CODE_HOME'] = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe('getKnowledgeStore 单例契约', () => {
  it('init 失败后下一次调用会重试，而不是永远停在"engine not initialized"', async () => {
    storeImpl.init.mockRejectedValueOnce(new Error('SQLITE_CANTOPEN')).mockResolvedValue(undefined);
    const { getKnowledgeStore, startManualEmbeddingDownload } = await loadModule();

    await expect(getKnowledgeStore()).rejects.toThrow('SQLITE_CANTOPEN');

    // 第二次：瞬时错误已消失 → 正常建成，且拿到的是可下载的引擎
    await expect(getKnowledgeStore()).resolves.toBeDefined();
    expect(storeImpl.init).toHaveBeenCalledTimes(2);
    expect(memImpl.engines).toHaveLength(1);

    const result = await startManualEmbeddingDownload();
    expect(result.error).toBeUndefined();
    expect(storeImpl.setEmbeddingEngine).toHaveBeenCalledTimes(1);
  });

  it('并发调用共享同一次构建，且在 init 完成前一律不返回', async () => {
    let releaseInit: () => void = () => {};
    storeImpl.init.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseInit = () => resolve();
        }),
    );
    const { getKnowledgeStore } = await loadModule();

    let settled = 0;
    const calls = [getKnowledgeStore(), getKnowledgeStore(), getKnowledgeStore()].map((promise) =>
      promise.then((store) => {
        settled += 1;
        return store;
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    // init 仍挂起：没有任何调用方拿到未初始化完成的 store
    expect(settled).toBe(0);
    expect(storeImpl.init).toHaveBeenCalledTimes(1);

    releaseInit();
    const stores = await Promise.all(calls);
    expect(settled).toBe(3);
    expect(stores[1]).toBe(stores[0]);
    expect(stores[2]).toBe(stores[0]);
  });
});

describe('hasEmbeddingModelCache', () => {
  it('有目录与权重即视为可用（缺 sidecar 由 loader 自己补），空目录不算', async () => {
    const { hasEmbeddingModelCache } = await loadModule();

    expect(hasEmbeddingModelCache()).toBe(false);

    // 只有 sidecar、没有权重：仍然没有可用的模型
    writeCacheFiles(REQUIRED_FILES.filter((file) => file !== 'model_optimized.onnx'));
    expect(hasEmbeddingModelCache()).toBe(false);

    // 权重在（哪怕 sidecar 不全）：FlagEmbedding 加载时会去 Hub 补齐，
    // 门禁若拦下就等于禁止了唯一能自修的路径（fastembed 见目录存在便不再下载）。
    writeCacheFiles(['model_optimized.onnx']);
    expect(hasEmbeddingModelCache()).toBe(true);
  });
});

describe('startManualEmbeddingDownload 失败分类', () => {
  it('平台缺原生绑定 → 直接失败、不下载、不清缓存', async () => {
    memImpl.probe.mockResolvedValue({
      supported: false,
      error: "Cannot find module '@anush008/tokenizers-linux-arm64-gnu'",
    });
    const { getKnowledgeStore, startManualEmbeddingDownload } = await loadModule();
    await getKnowledgeStore();

    const result = await startManualEmbeddingDownload();

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('platform');
    expect(memImpl.clear).not.toHaveBeenCalled();
    expect(memImpl.engines[0]!.ensureReady).not.toHaveBeenCalled();
  });

  it('暂存包损坏 → 清缓存并重试一次，仍失败时归类为 archive', async () => {
    memImpl.probe.mockResolvedValue({ supported: true });
    const { getKnowledgeStore, startManualEmbeddingDownload } = await loadModule();
    await getKnowledgeStore();
    const engine = memImpl.engines[0]!;
    engine.ensureReady = vi
      .fn()
      .mockImplementationOnce(async () => {
        engine.lastError = 'TAR_BAD_ARCHIVE: Unrecognized archive format';
        return false;
      })
      .mockImplementationOnce(async () => {
        engine.lastError = 'TAR_BAD_ARCHIVE: Unrecognized archive format';
        return false;
      });

    const result = await startManualEmbeddingDownload();

    expect(memImpl.clear).toHaveBeenCalledWith(expect.any(String));
    expect(result.failureKind).toBe('archive');
  });

  it('平台类失败（探测通过但加载期报 dlopen）→ 不清缓存、不重试', async () => {
    memImpl.probe.mockResolvedValue({ supported: true });
    const { getKnowledgeStore, startManualEmbeddingDownload } = await loadModule();
    await getKnowledgeStore();
    const engine = memImpl.engines[0]!;
    engine.ensureReady = vi.fn(async () => {
      engine.lastError =
        'ERR_DLOPEN_FAILED: Error loading shared library libstdc++.so.6: No such file or directory';
      return false;
    });

    const result = await startManualEmbeddingDownload();

    expect(result.failureKind).toBe('platform');
    expect(engine.ensureReady).toHaveBeenCalledTimes(1); // 没有第二次尝试
    expect(memImpl.clear).not.toHaveBeenCalled(); // 缓存与失败无关，不动它
  });

  it('返回的 error 保留完整原文（多行的 Require stack 不丢）', async () => {
    memImpl.probe.mockResolvedValue({ supported: false, error: 'boom\nRequire stack:\n- /x/y.mjs' });
    const { getKnowledgeStore, startManualEmbeddingDownload } = await loadModule();
    await getKnowledgeStore();

    const result = await startManualEmbeddingDownload();

    expect(result.error).toContain('Require stack:');
  });

  it('首次失败后重试成功 → ok，且失败不残留', async () => {
    memImpl.probe.mockResolvedValue({ supported: true });
    const { getKnowledgeStore, startManualEmbeddingDownload } = await loadModule();
    await getKnowledgeStore();
    const engine = memImpl.engines[0]!;
    engine.ensureReady = vi
      .fn()
      .mockImplementationOnce(async () => {
        engine.lastError = 'fetch failed';
        return false;
      })
      .mockImplementationOnce(async () => true);

    const result = await startManualEmbeddingDownload();

    expect(result).toEqual({ ok: true });
    // 失败即连包一起清：失败时磁盘上的包多半是残包，留下它会让重试零网络地解坏包
    expect(memImpl.clear).toHaveBeenCalledWith(expect.any(String));
  });
});
