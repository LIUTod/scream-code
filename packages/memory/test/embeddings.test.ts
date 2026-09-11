/**
 * embeddings.test.ts — fastembed 引擎的状态机语义（批次 B4）。
 *
 * 钉死 77e6c0e（startup embedding setup card + fail-fast ingestion）确立的错误路径契约：
 * - 模型加载失败（ensureReady / loadEmbedder 抛错）→ 标记 loadFailed，available=false，
 *   embedBatch 降级返回 null，下一次 ensureReady 会真正重试加载；
 * - 单批 embed 运行时失败 ≠ 加载失败：lastError 记录但 available 保持 true
 *   （共享引擎不能被一批数据永久拖垮）；
 * - sidecar（config/tokenizer）缺失时从 HuggingFace 补拉后重试 init；
 * - 引擎按 cacheDir 全局缓存复用。
 * fastembed 与 HuggingFace 网络一律打桩，不碰真模型/真网络。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildEmbeddingText,
  clearEmbeddingModelCache,
  createFastEmbedEngine,
  EMBEDDING_MODEL_NAME,
} from '../src/embeddings.js';
import type { MemoryMemo } from '../src/models.js';

// ─── fastembed stub ─────────────────────────────────────────────────

const FE_MODEL_ID = 'fast-bge-small-zh-v1.5';

const fe = vi.hoisted(() => ({
  /** 每次 FlagEmbedding.init 依序 shift 一个行为：返回 model / 返回 null / 抛错。 */
  impls: [] as Array<() => unknown>,
  opts: [] as unknown[],
}));

vi.mock('fastembed', () => ({
  FlagEmbedding: {
    init: vi.fn(async (opts?: unknown) => {
      fe.opts.push(opts);
      const impl = fe.impls.shift();
      if (impl === undefined) throw new Error('test fixture: no fastembed init behavior configured');
      return impl();
    }),
  },
  EmbeddingModel: {
    BGESmallZH: FE_MODEL_ID,
  },
}));

/** 可换行为的假模型：embed 返回 AsyncGenerator<number[][]>。 */
function makeModel() {
  const model = {
    mode: 'ok' as 'ok' | 'throw' | 'empty',
    async *embed(texts: string[]): AsyncGenerator<number[][], void, unknown> {
      if (model.mode === 'throw') throw new Error('onnx runtime crash');
      if (model.mode === 'empty') return;
      yield texts.map(() => [1, 0]);
    },
  };
  return model;
}

// 每个用例独立 cacheDir，避开模块级 engineCache 串扰（key = cacheDir）。
const testRoot = mkdtempSync(join(tmpdir(), 'scream-embeddings-test-'));
let dirCounter = 0;

function freshCacheDir(): string {
  dirCounter += 1;
  return join(testRoot, `engine-${dirCounter}`);
}

beforeEach(() => {
  fe.impls.length = 0;
  fe.opts.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// ─── buildEmbeddingText ────────────────────────────────────────────

describe('buildEmbeddingText', () => {
  it('拼接 userNeed/approach/whatWorked 三个语义字段', () => {
    const memo = {
      userNeed: '需要 A',
      approach: '做法 B',
      whatWorked: '有效 C',
      outcome: '不应参与',
      whatFailed: '也不应参与',
    } as MemoryMemo;
    expect(buildEmbeddingText(memo)).toBe('需要 A 做法 B 有效 C');
  });
});

// ─── 引擎缓存与静态身份 ────────────────────────────────────────────

describe('createFastEmbedEngine 缓存', () => {
  it('同 cacheDir 复用同一实例，不同 cacheDir 隔离；初始 available=false，modelName 固定', () => {
    const dirA = freshCacheDir();
    const a1 = createFastEmbedEngine(dirA);
    const a2 = createFastEmbedEngine(dirA);
    const b = createFastEmbedEngine(freshCacheDir());

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1.modelName).toBe(EMBEDDING_MODEL_NAME);
    expect(EMBEDDING_MODEL_NAME).toBe('bge-small-zh-v1.5');
    expect(a1.available).toBe(false);
    expect(a1.lastError).toBeUndefined();
  });
});

// ─── ensureReady / embedBatch 状态机 ───────────────────────────────

describe('ensureReady 成功路径', () => {
  it('init 成功后 available=true；embedBatch 产出 Float32Array 向量；重复 ensureReady 不再 init；空数组直接返回 []', async () => {
    const model = makeModel();
    fe.impls.push(() => model);
    const dir = freshCacheDir();
    const engine = createFastEmbedEngine(dir);

    expect(await engine.ensureReady()).toBe(true);
    expect(engine.available).toBe(true);
    expect(engine.lastError).toBeUndefined();
    expect(fe.opts[0]).toEqual({ model: FE_MODEL_ID, cacheDir: dir });
    expect(existsSync(dir)).toBe(true); // loadEmbedder 会 mkdirSync(cacheDir)

    const vectors = await engine.embedBatch(['hello', 'world']);
    expect(vectors).not.toBeNull();
    expect(vectors).toHaveLength(2);
    expect(vectors![0]).toBeInstanceOf(Float32Array);
    expect(Array.from(vectors![0]!)).toEqual([1, 0]);

    // 已就绪时短路，不触发第二次 init
    expect(await engine.ensureReady()).toBe(true);
    expect(fe.opts).toHaveLength(1);

    // 空输入不碰模型
    expect(await engine.embedBatch([])).toEqual([]);
  });
});

describe('加载失败 → fail-fast + 可重试', () => {
  it('init 抛错 → ensureReady=false / available=false / lastError 记录，embedBatch 降级 null；再次 ensureReady 真正重试并恢复', async () => {
    fe.impls.push(
      () => {
        throw new Error('download failed: ENOTFOUND');
      },
      () => makeModel(),
    );
    const engine = createFastEmbedEngine(freshCacheDir());

    expect(await engine.ensureReady()).toBe(false);
    expect(engine.available).toBe(false);
    expect(engine.lastError).toBe('download failed: ENOTFOUND');
    // 不可用时 embedBatch 直接降级，且不调用模型
    expect(await engine.embedBatch(['x'])).toBeNull();

    expect(await engine.ensureReady()).toBe(true);
    expect(engine.available).toBe(true);
    expect(engine.lastError).toBeUndefined();
    expect(fe.opts).toHaveLength(2); // 第一次失败后确实重新走了加载
    expect(await engine.embedBatch(['x'])).toHaveLength(1);
  });

  it('init 返回空模型（null）→ false + 固定诊断文案 "fastembed returned an empty model"，重试同样生效', async () => {
    fe.impls.push(() => null, () => makeModel());
    const engine = createFastEmbedEngine(freshCacheDir());

    expect(await engine.ensureReady()).toBe(false);
    expect(engine.available).toBe(false);
    expect(engine.lastError).toBe('fastembed returned an empty model');

    expect(await engine.ensureReady()).toBe(true);
    expect(engine.available).toBe(true);
  });
});

describe('运行时批次失败 ≠ 加载失败（共享引擎不能被一批拖垮）', () => {
  it('embed 抛错 → embedBatch=null + lastError，但 available 保持 true，下一批自动恢复；空产出返回 null 但不算加载失败', async () => {
    const model = makeModel();
    fe.impls.push(() => model);
    const engine = createFastEmbedEngine(freshCacheDir());
    expect(await engine.ensureReady()).toBe(true);

    model.mode = 'throw';
    expect(await engine.embedBatch(['bad-batch'])).toBeNull();
    expect(engine.lastError).toBe('onnx runtime crash');
    expect(engine.available).toBe(true); // 关键：未被打成永久降级

    model.mode = 'empty';
    expect(await engine.embedBatch(['nothing'])).toBeNull(); // 零向量 → null 让调用方按降级处理
    expect(engine.available).toBe(true);

    model.mode = 'ok';
    expect(await engine.embedBatch(['good-batch'])).toHaveLength(1);
    // init 始终只发生了一次（运行时失败不触发重载）
    expect(fe.opts).toHaveLength(1);
  });
});

describe('sidecar 缺失自愈（HuggingFace 补拉后重试 init）', () => {
  const SIDECARS = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json'];

  it('init 抛 "Config file not found" → 拉取 4 个 sidecar 落盘 → 第二次 init 成功', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(`stub-for-${url}`).buffer,
    }));
    vi.stubGlobal('fetch', fetchMock);

    fe.impls.push(
      () => {
        throw new Error(`Config file not found for model ${FE_MODEL_ID}`);
      },
      () => makeModel(),
    );
    const dir = freshCacheDir();
    const engine = createFastEmbedEngine(dir);

    expect(await engine.ensureReady()).toBe(true);
    expect(fe.opts).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const file of SIDECARS) {
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(`/resolve/main/${file}`))).toBe(true);
      expect(existsSync(join(dir, FE_MODEL_ID, file))).toBe(true);
    }
  });

  it('HuggingFace 也不可达 → 尽力而为不抛出，仍会重试 init（由 init 决定成败）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network unreachable');
    }));
    fe.impls.push(
      () => {
        throw new Error('Tokenizer file not found');
      },
      () => makeModel(),
    );
    const engine = createFastEmbedEngine(freshCacheDir());

    expect(await engine.ensureReady()).toBe(true);
    expect(fe.opts).toHaveLength(2);
  });

  it('非 sidecar 类错误不触发补拉也不重试，原样失败', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }));
    vi.stubGlobal('fetch', fetchMock);
    fe.impls.push(
      () => {
        throw new Error('CUDA out of memory');
      },
      () => makeModel(),
    );
    const engine = createFastEmbedEngine(freshCacheDir());

    expect(await engine.ensureReady()).toBe(false);
    expect(engine.lastError).toBe('CUDA out of memory');
    expect(fe.opts).toHaveLength(1); // 没有 sidecar 重试路径
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── cosineSimilarity / clearEmbeddingModelCache ───────────────────

describe('cosineSimilarity', () => {
  const engine = createFastEmbedEngine(); // 无 cacheDir 的共享实例，纯数学方法

  it('表驱动：同向=1、正交=0、反向=-1、维度不等=0、零向量=0、空向量=0', () => {
    const v = (arr: number[]) => Float32Array.from(arr);
    expect(engine.cosineSimilarity(v([1, 2, 3]), v([2, 4, 6]))).toBeCloseTo(1, 6);
    expect(engine.cosineSimilarity(v([1, 0]), v([0, 3]))).toBe(0);
    expect(engine.cosineSimilarity(v([1, 0]), v([-1, 0]))).toBeCloseTo(-1, 6);
    expect(engine.cosineSimilarity(v([1, 0]), v([1, 0, 0]))).toBe(0);
    expect(engine.cosineSimilarity(v([0, 0]), v([1, 1]))).toBe(0);
    expect(engine.cosineSimilarity(v([]), v([]))).toBe(0);
  });
});

describe('clearEmbeddingModelCache', () => {
  it('只删除 fast-bge-small-zh-v1.5 子目录，保留兄弟文件；目录不存在时静默', () => {
    const dir = freshCacheDir();
    const modelDir = join(dir, FE_MODEL_ID);
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'model_optimized.onnx'), 'junk');
    writeFileSync(join(dir, 'keep-me.txt'), 'x');

    clearEmbeddingModelCache(dir);
    expect(existsSync(modelDir)).toBe(false);
    expect(existsSync(join(dir, 'keep-me.txt'))).toBe(true);

    // 幂等：再删一次（目录已不存在）不抛错
    clearEmbeddingModelCache(dir);
  });
});
