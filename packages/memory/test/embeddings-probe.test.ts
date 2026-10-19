/**
 * embeddings-probe.test.ts — probeLocalEmbeddingSupport 的失败面。
 *
 * 与 embeddings.test.ts 分开：这里必须让运行时模块在**导入期**就抛错，模拟
 * "安装被破坏（模块缺失）"；那边需要模块可成功导入以覆盖加载状态机。
 */
import { describe, expect, it, vi } from 'vitest';

// vitest 会把工厂抛出的错误包成自己的提示文本，所以这里只钉"判定为不支持
// 且带回错误"，原文级别的断言放在 classifyEmbeddingFailure 的表驱动用例
// 与 app 侧 knowledge-store.test.ts。
vi.mock('onnxruntime-web', async () => {
  throw new Error("Cannot find package 'onnxruntime-web' imported from /x/dist.mjs");
});

const { probeLocalEmbeddingSupport } = await import('../src/embeddings.js');

describe('probeLocalEmbeddingSupport', () => {
  it('导入期失败 → supported:false，并带回一条非空错误', async () => {
    const result = await probeLocalEmbeddingSupport();

    expect(result.supported).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
