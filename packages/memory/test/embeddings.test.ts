/**
 * embeddings.test.ts — WASM 嵌入引擎的状态机语义。
 *
 * 钉死既有错误路径契约（不随引擎更换而改变）：
 * - 加载失败（session 创建抛错 / 返回空）→ loadFailed，available=false，
 *   embedBatch 降级 null，下一次 ensureReady 真正重试；
 * - 单批推理失败 ≠ 加载失败：lastError 记录但 available 保持 true；
 * - 引擎按 cacheDir 全局缓存复用；
 * - 自托管下载器：状态码校验、sha 校验、暂存清理、进度/超时守卫。
 * onnxruntime-web 与 tokenizer 全程打桩，不碰真模型/真网络。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { create as tarCreate } from 'tar';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildEmbeddingText,
  classifyEmbeddingFailure,
  probeLocalEmbeddingSupport,
  clearEmbeddingModelCache,
  createEmbeddingEngine,
  createFastEmbedEngine,
  ensureEmbeddingModelFiles,
  hasEmbeddingModelCache,
  EMBEDDING_MODEL_NAME,
} from '../src/embeddings.js';
import type { MemoryMemo } from '../src/models.js';

// ─── onnxruntime-web / tokenizer 打桩 ───────────────────────────────

const EMBED_MODEL_ID = 'fast-bge-small-zh-v1.5';

const ort = vi.hoisted(() => ({
  /** 每次 InferenceSession.create 依序 shift 一个行为：返回 session / 抛错 / 返回 null。 */
  createImpls: [] as Array<() => unknown>,
  /** 记录 create 的入参（模型字节数 / 执行提供者）。 */
  createOpts: [] as Array<{ modelLength: number; options?: unknown }>,
  /** 记录每次 run 的 feeds，用于断言截断/批形状。 */
  runs: [] as Array<Record<string, { data: ArrayLike<bigint>; dims: readonly number[] }>>,
  /** session.run 的行为开关。 */
  runMode: 'ok' as 'ok' | 'throw',
  hiddenSize: 512,
  /** 由 mock 工厂填充：造一个可用的假 session。 */
  sessionFactory: (() => ({})) as () => unknown,
}));

vi.mock('onnxruntime-web', () => {
  class Tensor {
    public constructor(
      public readonly type: string,
      public readonly data: Float32Array | BigInt64Array,
      public readonly dims: readonly number[],
    ) {}
  }

  const makeSession = () => ({
    async run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>> {
      ort.runs.push(feeds as never);
      if (ort.runMode === 'throw') throw new Error('onnx runtime crash');
      const ids = feeds['input_ids']!;
      const [rows, width] = ids.dims as [number, number];
      // last_hidden_state[rows][width][hidden]，只填 CLS 行的前两维：
      // [0] = 第二个 token id（可区分文本），[1] = 1（保证方向不退化）。
      const hidden = new Float32Array(rows * width * ort.hiddenSize);
      for (let row = 0; row < rows; row++) {
        hidden[row * width * ort.hiddenSize] = Number(ids.data[row * width + 1] ?? 0n);
        hidden[row * width * ort.hiddenSize + 1] = 1;
      }
      return { last_hidden_state: new Tensor('float32', hidden, [rows, width, ort.hiddenSize]) };
    },
  });
  ort.sessionFactory = makeSession as () => unknown;

  return {
    Tensor,
    env: { wasm: { numThreads: 1, wasmPaths: '' }, logLevel: 'error' },
    InferenceSession: {
      create: vi.fn(async (model: Uint8Array, options?: unknown) => {
        ort.createOpts.push({ modelLength: model?.byteLength ?? -1, options });
        const impl = ort.createImpls.shift();
        if (impl === undefined) throw new Error('test fixture: no session behavior configured');
        return impl();
      }),
    },
  };
});

vi.mock('@huggingface/tokenizers', () => ({
  Tokenizer: class {
    public constructor(public readonly json: unknown, public readonly config: unknown) {}
    /** 确定性编码：ids = [CLS, ...每字符一个 token, SEP]（长度随文本增长，供截断用例断言）。 */
    public encode(text: string): { ids: number[]; attention_mask: number[]; token_type_ids: number[] } {
      const ids = [101, ...Array.from(text).map((ch) => ch.codePointAt(0)! % 1000), 102];
      return { ids, attention_mask: ids.map(() => 1), token_type_ids: ids.map(() => 0) };
    }
  },
}));

/** 需要文件齐备才算已安装：三件套缺一不可。 */
function seedModelFiles(dir: string): string {
  const modelDir = join(dir, EMBED_MODEL_ID);
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, 'model_optimized.onnx'), 'stub weights');
  writeFileSync(join(modelDir, 'tokenizer.json'), '{"stub":true}');
  writeFileSync(join(modelDir, 'tokenizer_config.json'), '{"stub":true}');
  return dir;
}

/** 造一个真实 tar.gz 夹具（三件套齐全），并按 chunk 回放为 ReadableStream。 */
async function makeModelArchive(chunkSize = 4096): Promise<{ payload: Uint8Array; onnxSha: string }> {
  const src = mkdtempSync(join(tmpdir(), 'scream-embedding-archive-src-'));
  seedModelFiles(src);
  const archivePath = join(testRoot, `bge-fixture-${dirCounter}.tar.gz`);
  dirCounter += 1;
  await tarCreate({ gzip: true, cwd: src, file: archivePath }, [EMBED_MODEL_ID]);
  const bytes = new Uint8Array(await readFile(archivePath));
  const onnxBytes = await readFile(join(src, EMBED_MODEL_ID, 'model_optimized.onnx'));
  const onnxSha = createHash('sha256').update(onnxBytes).digest('hex');
  return { payload: bytes, onnxSha };
}

function streamResponse(payload: Uint8Array, chunkSize = 4096): Response {
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= payload.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(payload.subarray(offset, Math.min(offset + chunkSize, payload.byteLength)));
      offset += chunkSize;
    },
  });
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(payload.byteLength) : null) },
    body,
  } as unknown as Response;
}

// 每个用例独立 cacheDir，避开模块级 engineCache 串扰（key = cacheDir）。
const testRoot = mkdtempSync(join(tmpdir(), 'scream-embeddings-test-'));
let dirCounter = 0;

function freshCacheDir(): string {
  dirCounter += 1;
  return join(testRoot, `engine-${dirCounter}`);
}

beforeEach(() => {
  ort.createImpls.length = 0;
  ort.createOpts.length = 0;
  ort.runs.length = 0;
  ort.runMode = 'ok';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
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

describe('createEmbeddingEngine 缓存', () => {
  it('同 cacheDir 复用同一实例，不同 cacheDir 隔离；旧名是同一工厂的别名；初始 available=false', () => {
    const dirA = freshCacheDir();
    const a1 = createEmbeddingEngine(dirA);
    const a2 = createEmbeddingEngine(dirA);
    const b = createEmbeddingEngine(freshCacheDir());

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(createFastEmbedEngine).toBe(createEmbeddingEngine);
    expect(a1.modelName).toBe(EMBEDDING_MODEL_NAME);
    expect(EMBEDDING_MODEL_NAME).toBe('bge-small-zh-v1.5');
    expect(a1.available).toBe(false);
    expect(a1.lastError).toBeUndefined();
  });
});

// ─── ensureReady / embedBatch 状态机 ───────────────────────────────

describe('createEmbeddingEngine 缓存 key 归一', () => {
  it('相对路径与绝对路径（不同 join 写法）命中同一实例', () => {
    const absolute = freshCacheDir();
    const relative = path.relative(process.cwd(), absolute);
    const first = createEmbeddingEngine(absolute);
    const second = createEmbeddingEngine(relative);
    expect(second).toBe(first);
  });
});

describe('ensureReady 成功路径', () => {
  it('session 建成后 available=true；embedBatch 出 Float32Array（CLS 归一化）；重复 ensureReady 不再建会话；空数组返回 []', async () => {
    ort.createImpls.push(() => ort.sessionFactory());
    const dir = seedModelFiles(freshCacheDir());
    const engine = createEmbeddingEngine(dir);

    expect(await engine.ensureReady()).toBe(true);
    expect(engine.available).toBe(true);
    expect(engine.lastError).toBeUndefined();
    expect(ort.createOpts).toHaveLength(1);
    expect(ort.createOpts[0]?.options).toEqual({ executionProviders: ['wasm'] });
    expect(existsSync(dir)).toBe(true);

    const vectors = await engine.embedBatch(['hello', 'world']);
    expect(vectors).not.toBeNull();
    expect(vectors).toHaveLength(2);
    expect(vectors![0]).toBeInstanceOf(Float32Array);
    // CLS 归一化后 [0] 是首个非零分量的方向占比；[1] 固定 1 → 断言两者关系而非具体值
    const first = vectors![0]!;
    expect(first).toHaveLength(512);
    expect(Math.hypot(first[0]!, first[1]!)).toBeCloseTo(1, 5);

    expect(await engine.ensureReady()).toBe(true);
    expect(ort.createOpts).toHaveLength(1); // 未二次建会话

    expect(await engine.embedBatch([])).toEqual([]);
  });

  it('超过 512 token 的文本被截断到 512（三条输入同宽）', async () => {
    ort.createImpls.push(() => ort.sessionFactory());
    const engine = createEmbeddingEngine(seedModelFiles(freshCacheDir()));
    await engine.ensureReady();

    const longText = 'x'.repeat(900);
    const vectors = await engine.embedBatch([longText]);
    expect(vectors).toHaveLength(1);
    const run = ort.runs.at(-1)!;
    expect(run['input_ids']!.dims).toEqual([1, 512]);
    expect(run['attention_mask']!.dims).toEqual([1, 512]);
    expect(run['token_type_ids']!.dims).toEqual([1, 512]);
    // 截断必须保住句尾 special token（[SEP]=102）与句首 [CLS]=101，
    // 否则送进编码器的是"没闭合"的句子，长文本会偏离参考向量。
    expect(Number(run['input_ids']!.data[0])).toBe(101);
    expect(Number(run['input_ids']!.data[511])).toBe(102);
  });

  it('分桶批处理必须回填到原始顺序（17 条乱序长度 → 向量与文本一一对应）', async () => {
    ort.createImpls.push(() => ort.sessionFactory());
    const engine = createEmbeddingEngine(seedModelFiles(freshCacheDir()));
    await engine.ensureReady();

    // 长度乱序：encode 里第二个 token = 首字符码 → 向量方向可识别文本
    const texts = Array.from({ length: 17 }, (_, i) => `${String.fromCodePoint(0x4e00 + i)}`.repeat(((i * 7) % 17) + 1));
    const vectors = (await engine.embedBatch(texts))!;
    expect(vectors).toHaveLength(texts.length);
    texts.forEach((text, index) => {
      const expectedCode = text.codePointAt(0)! % 1000;
      const [a, b] = vectors[index]!;
      expect(a! / b!).toBeCloseTo(expectedCode, 3); // 方向 ∝ (code, 1)
    });
  });
});

// ─── 加载失败 → fail-fast + 可重试 ─────────────────────────────────

describe('加载失败 → fail-fast + 可重试', () => {
  it('session 创建抛错 → ensureReady=false / available=false / lastError 记录；重试恢复', async () => {
    ort.createImpls.push(
      () => {
        throw new Error('download failed: ENOTFOUND');
      },
      () => ort.sessionFactory(),
    );
    const engine = createEmbeddingEngine(seedModelFiles(freshCacheDir()));

    expect(await engine.ensureReady()).toBe(false);
    expect(engine.available).toBe(false);
    expect(engine.lastError).toBe('download failed: ENOTFOUND');
    expect(await engine.embedBatch(['x'])).toBeNull();

    expect(await engine.ensureReady()).toBe(true);
    expect(engine.available).toBe(true);
    expect(engine.lastError).toBeUndefined();
    expect(ort.createOpts).toHaveLength(2);
    expect(await engine.embedBatch(['x'])).toHaveLength(1);
  });

  it('session 创建返回空（null）→ 固定诊断文案 "embedding runtime returned an empty session"', async () => {
    ort.createImpls.push(() => null, () => ort.sessionFactory());
    const engine = createEmbeddingEngine(seedModelFiles(freshCacheDir()));

    expect(await engine.ensureReady()).toBe(false);
    expect(engine.lastError).toBe('embedding runtime returned an empty session');

    expect(await engine.ensureReady()).toBe(true);
    expect(engine.available).toBe(true);
  });
});

// ─── 运行时批次失败 ≠ 加载失败 ─────────────────────────────────────

describe('运行时批次失败 ≠ 加载失败（共享引擎不能被一批拖垮）', () => {
  it('run 抛错 → embedBatch=null + lastError，available 保持 true，下一批自动恢复；不触发重载', async () => {
    ort.createImpls.push(() => ort.sessionFactory());
    const engine = createEmbeddingEngine(seedModelFiles(freshCacheDir()));
    expect(await engine.ensureReady()).toBe(true);

    ort.runMode = 'throw';
    expect(await engine.embedBatch(['bad-batch'])).toBeNull();
    expect(engine.lastError).toBe('onnx runtime crash');
    expect(engine.available).toBe(true);

    ort.runMode = 'ok';
    expect(await engine.embedBatch(['good-batch'])).toHaveLength(1);
    expect(ort.createOpts).toHaveLength(1); // 运行时失败不触发重载
  });
});

// ─── 进度回调接线（下载 → 校验 → 加载） ────────────────────────────

describe('setProgressListener 阶段接线', () => {
  it('未安装缓存时依次上报 download/verify（fake 包 sha 不匹配 → 失败但阶段可见）', async () => {
    const fixture = await makeModelArchive();
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(fixture.payload)));
    const engine = createEmbeddingEngine(freshCacheDir());
    const phases: string[] = [];
    engine.setProgressListener!((progress) => phases.push(progress.phase));

    // 引擎内部不传 expectedOnnxSha256 → 真 pin 校验失败，但阶段序列已完整
    expect(await engine.ensureReady()).toBe(false);
    expect(phases[0]).toBe('download');
    expect(phases).toContain('verify');
    expect(phases.at(-1)).toBe('verify');
    expect(classifyEmbeddingFailure(engine.lastError)).toBe('archive'); // 校验失败 = 包坏了，可重试
  });

  it('权重已就位时只上报 load 阶段（无网络）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    ort.createImpls.push(() => ort.sessionFactory());
    const engine = createEmbeddingEngine(seedModelFiles(freshCacheDir()));
    const phases: string[] = [];
    engine.setProgressListener!((progress) => phases.push(progress.phase));

    expect(await engine.ensureReady()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(phases).toEqual(['load']);
  });
});

// ─── ensureEmbeddingModelFiles 自托管下载器 ─────────────────────────

describe('ensureEmbeddingModelFiles 自托管下载器', () => {
  it('三件套已存在时短路：不发请求、不落暂存文件', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const dir = seedModelFiles(freshCacheDir());

    await expect(ensureEmbeddingModelFiles(dir)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('下载→解包→校验✓：三件套落盘、暂存包清理、重复调用不再拉网', async () => {
    const fixture = await makeModelArchive();
    const fetchMock = vi.fn(async (_url: string) => streamResponse(fixture.payload));
    vi.stubGlobal('fetch', fetchMock);
    const dir = freshCacheDir();

    await expect(
      ensureEmbeddingModelFiles(dir, { sourceUrl: 'https://stub/pkg.tar.gz', expectedOnnxSha256: fixture.onnxSha }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://stub/pkg.tar.gz');
    for (const file of ['model_optimized.onnx', 'tokenizer.json', 'tokenizer_config.json']) {
      expect(existsSync(join(dir, EMBED_MODEL_ID, file))).toBe(true);
    }
    expect(existsSync(join(dir, `${EMBED_MODEL_ID}.tar.gz.part`))).toBe(false);

    await expect(ensureEmbeddingModelFiles(dir)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('进度回调：单调不减、最终 received === content-length、末次必达', async () => {
    const fixture = await makeModelArchive(1024);
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(fixture.payload, 1024)));
    const events: Array<{ received: number; total?: number }> = [];

    await ensureEmbeddingModelFiles(freshCacheDir(), {
      expectedOnnxSha256: fixture.onnxSha,
      onProgress: (received, total) => events.push({ received, total }),
    });

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toEqual({ received: 0, total: fixture.payload.byteLength });
    expect(events.at(-1)).toEqual({ received: fixture.payload.byteLength, total: fixture.payload.byteLength });
    for (let i = 1; i < events.length; i++) expect(events[i]!.received).toBeGreaterThanOrEqual(events[i - 1]!.received);
  });

  it('空闲超时：流卡住超过 idleTimeoutMs → 报 timed out、归类 network、暂存与半成品全清', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
          // 之后既不产出也不关闭 → 模拟 trickle/半死连接
        },
      }),
    })));
    const dir = freshCacheDir();

    await expect(
      ensureEmbeddingModelFiles(dir, { idleTimeoutMs: 25 }),
    ).rejects.toThrow(/timed out/);

    expect(classifyEmbeddingFailure('model download timed out (received 7 of ? bytes): https://x')).toBe('network');
    expect(existsSync(join(dir, `${EMBED_MODEL_ID}.tar.gz.part`))).toBe(false);
    expect(existsSync(join(dir, EMBED_MODEL_ID))).toBe(false);
  });

  it('总超时：持续低速流超过 totalTimeoutMs → 同样中止并清理', async () => {
    let pushes = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pushes += 1;
          controller.enqueue(new Uint8Array(1024));
          return new Promise((resolve) => setTimeout(resolve, 5));
        },
      }),
    })));
    const dir = freshCacheDir();

    await expect(
      ensureEmbeddingModelFiles(dir, { idleTimeoutMs: 60_000, totalTimeoutMs: 40 }),
    ).rejects.toThrow(/timed out/);

    expect(pushes).toBeGreaterThan(0);
    expect(existsSync(join(dir, `${EMBED_MODEL_ID}.tar.gz.part`))).toBe(false);
  });

  it('模型源返回 403 → 报出状态码、不落任何文件', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 403,
      headers: { get: () => null },
      body: null,
    })));
    const dir = freshCacheDir();

    await expect(ensureEmbeddingModelFiles(dir)).rejects.toThrow(/HTTP 403/);
    expect(classifyEmbeddingFailure('model source returned HTTP 403 for https://x')).toBe('network');
    expect(existsSync(join(dir, `${EMBED_MODEL_ID}.tar.gz.part`))).toBe(false);
    expect(existsSync(join(dir, EMBED_MODEL_ID))).toBe(false);
  });

  it('下载到垃圾包（非 gzip）→ tar 解包报错、暂存物与半成品目录全部清理', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(new TextEncoder().encode('403 AccessDenied XML junk'))));
    const dir = freshCacheDir();

    await expect(ensureEmbeddingModelFiles(dir)).rejects.toThrow();
    expect(existsSync(join(dir, `${EMBED_MODEL_ID}.tar.gz.part`))).toBe(false);
    expect(existsSync(join(dir, EMBED_MODEL_ID))).toBe(false);
  });

  it('权重 sha 不匹配 → 报 mismatch 并把落地物清掉', async () => {
    const fixture = await makeModelArchive();
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(fixture.payload)));
    const dir = freshCacheDir();

    await expect(
      ensureEmbeddingModelFiles(dir, { sourceUrl: 'https://stub/pkg.tar.gz', expectedOnnxSha256: 'deadbeef'.repeat(8) }),
    ).rejects.toThrow(/sha256 mismatch/);

    expect(existsSync(join(dir, EMBED_MODEL_ID))).toBe(false);
    expect(existsSync(join(dir, `${EMBED_MODEL_ID}.tar.gz.part`))).toBe(false);
  });

  it('SCREAM_CODE_EMBEDDING_MODEL_URL 环境变量改为下载来源', async () => {
    const fixture = await makeModelArchive();
    const fetchMock = vi.fn(async (_url: string) => streamResponse(fixture.payload));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('SCREAM_CODE_EMBEDDING_MODEL_URL', 'https://env-override/pkg.tar.gz');

    await expect(
      ensureEmbeddingModelFiles(freshCacheDir(), { expectedOnnxSha256: fixture.onnxSha }),
    ).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0]![0]).toBe('https://env-override/pkg.tar.gz');
  });
});

// ─── 缓存判定（三件套） ────────────────────────────────────────────

describe('hasEmbeddingModelCache 三件套判定', () => {
  it('三件套齐全 → true；缺任一 → false（旧缓存半装态会触发重下）', () => {
    const dir = freshCacheDir();
    mkdirSync(join(dir, EMBED_MODEL_ID), { recursive: true });
    writeFileSync(join(dir, EMBED_MODEL_ID, 'model_optimized.onnx'), 'w');
    expect(hasEmbeddingModelCache(dir)).toBe(false); // 只有权重

    writeFileSync(join(dir, EMBED_MODEL_ID, 'tokenizer.json'), '{}');
    expect(hasEmbeddingModelCache(dir)).toBe(false); // 还缺 tokenizer_config

    writeFileSync(join(dir, EMBED_MODEL_ID, 'tokenizer_config.json'), '{}');
    expect(hasEmbeddingModelCache(dir)).toBe(true);

    rmSync(join(dir, EMBED_MODEL_ID, 'tokenizer.json'));
    expect(hasEmbeddingModelCache(dir)).toBe(false);
  });

  it('目录不存在 → false；clearEmbeddingModelCache 同时清目录与遗留 tar.gz', () => {
    const dir = freshCacheDir();
    expect(hasEmbeddingModelCache(dir)).toBe(false);

    seedModelFiles(dir);
    writeFileSync(join(dir, `${EMBED_MODEL_ID}.tar.gz`), 'legacy');
    clearEmbeddingModelCache(dir);
    expect(existsSync(join(dir, EMBED_MODEL_ID))).toBe(false);
    expect(existsSync(join(dir, `${EMBED_MODEL_ID}.tar.gz`))).toBe(false);
    expect(hasEmbeddingModelCache(dir)).toBe(false);
  });
});

// ─── 失败分类 ──────────────────────────────────────────────────────

describe('classifyEmbeddingFailure', () => {
  it('四类分流：install / archive / network / other；旧的 platform 文案不再命中', () => {
    expect(classifyEmbeddingFailure("Cannot find package 'onnxruntime-web' imported from /x/dist.mjs")).toBe('install');
    expect(classifyEmbeddingFailure("Cannot find module '@huggingface/tokenizers'")).toBe('install');
    expect(classifyEmbeddingFailure('TAR_BAD_ARCHIVE: Unrecognized archive format')).toBe('archive');
    expect(classifyEmbeddingFailure('incorrect header check')).toBe('archive');
    expect(classifyEmbeddingFailure('fetch failed')).toBe('network');
    expect(classifyEmbeddingFailure('model download timed out (received 0 of ? bytes): https://x')).toBe('network');
    expect(classifyEmbeddingFailure('model source returned HTTP 403 for https://x')).toBe('network');
    expect(classifyEmbeddingFailure('model package is missing tokenizer.json after extraction: https://x')).toBe('archive');
    expect(classifyEmbeddingFailure('model weights sha256 mismatch (abc… != def…): https://x')).toBe('archive');
    expect(classifyEmbeddingFailure('model source returned an empty body for https://x')).toBe('network');
    expect(classifyEmbeddingFailure('GLIBC_2.35 not found')).toBe('other');
    expect(classifyEmbeddingFailure(undefined)).toBe('other');
  });
});

// ─── probeLocalEmbeddingSupport ────────────────────────────────────

describe('probeLocalEmbeddingSupport', () => {
  it('模块齐备 → supported', async () => {
    await expect(probeLocalEmbeddingSupport()).resolves.toEqual({ supported: true });
  });

  it('模块缺失（安装被破坏）→ supported:false 且带回原始错误文案', async () => {
    vi.resetModules();
    vi.doMock('@huggingface/tokenizers', () => {
      throw new Error("Cannot find package '@huggingface/tokenizers' imported from /x/dist.mjs");
    });
    try {
      const fresh = await import('../src/embeddings.js');
      const result = await fresh.probeLocalEmbeddingSupport();
      expect(result.supported).toBe(false);
      // 断言不依赖 vitest 对 mock 工厂错误的包装文案，只要求把失败透出；
      // 真实安装缺失文案的分类由 classifyEmbeddingFailure 用例锁定。
      expect(typeof result.error).toBe('string');
      expect((result.error ?? '').length).toBeGreaterThan(0);
    } finally {
      vi.doUnmock('@huggingface/tokenizers');
      vi.resetModules();
    }
  });
});
