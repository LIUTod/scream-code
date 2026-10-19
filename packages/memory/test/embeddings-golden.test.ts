/**
 * embeddings-golden.test.ts — 迁移等价性门禁。
 *
 * 用真实 WASM 管线跑固定语料，与迁移前原生栈留下的参考向量逐条比对余弦。
 * 这是"换引擎不改语义"的硬证据（实测余弦 = 1.0），并且因为批处理会重排
 * 文本顺序，逐条比对同时锁死"向量回填到原始下标"这一顺序契约。
 *
 * 需要本机模型缓存（~/.scream-code/cache/fastembed 或 SCREAM_TEST_EMBED_CACHE）；
 * CI 无模型 → 自动跳过，不产生红色。发版前必须在本机跑绿。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createEmbeddingEngine } from '../src/embeddings.js';
import golden from './fixtures/embedding-golden.json' with { type: 'json' };

const cacheDir = process.env['SCREAM_TEST_EMBED_CACHE']
  ?? join(homedir(), '.scream-code', 'cache', 'fastembed');
const modelDir = join(cacheDir, 'fast-bge-small-zh-v1.5');
const ready = existsSync(join(modelDir, 'model_optimized.onnx'))
  && existsSync(join(modelDir, 'tokenizer.json'))
  && existsSync(join(modelDir, 'tokenizer_config.json'));

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

describe.skipIf(!ready)('黄金向量等价（WASM 管线 vs 迁移前原生栈参考值）', () => {
  it('逐条余弦 > 0.9999，顺序与文本一一对应', async () => {
    const engine = createEmbeddingEngine(cacheDir);
    expect(await engine.ensureReady()).toBe(true);

    const vectors = await engine.embedBatch(golden.texts);
    expect(vectors).not.toBeNull();
    expect(vectors).toHaveLength(golden.texts.length);

    golden.texts.forEach((text, index) => {
      const got = Array.from(vectors![index]!);
      const want = golden.vectors[index]!;
      expect(got).toHaveLength(want.length);
      const score = cosine(got, want);
      expect(score, `cosine for #${index} "${text}"`).toBeGreaterThan(0.9999);
    });
  });

  it('反序输入同样逐条对应（批处理重排后必须回填原序）', async () => {
    const engine = createEmbeddingEngine(cacheDir);
    await engine.ensureReady();

    const reversedTexts = [...golden.texts].toReversed();
    const reversedVectors = await engine.embedBatch(reversedTexts);
    reversedTexts.forEach((text, index) => {
      const originalIndex = golden.texts.length - 1 - index;
      const score = cosine(Array.from(reversedVectors![index]!), golden.vectors[originalIndex]!);
      expect(score, `cosine for reversed #${index} "${text}"`).toBeGreaterThan(0.9999);
    });
  });
});
