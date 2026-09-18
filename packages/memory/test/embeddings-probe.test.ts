/**
 * embeddings-probe.test.ts — probeLocalEmbeddingSupport 的失败面。
 *
 * 与 embeddings.test.ts 分开：这里必须让 fastembed 在**导入期**就抛错，模拟
 * "当前平台没有已发布的 tokenizer 原生绑定"（冷进程实测：import 即抛
 * `Cannot find module '@anush008/tokenizers-…'`，早于任何网络 I/O）；
 * 那边需要 fastembed 可成功导入以覆盖加载状态机。
 */
import { describe, expect, it, vi } from 'vitest';

// fastembed 在导入期加载原生 tokenizer 绑定，平台缺包时 `import` 直接 reject ——
// 这正是要覆盖的失败面。vitest 会把工厂抛出的错误包成自己的提示文本，
// 所以这里只钉"判定为不支持且带回错误"，原文级别的断言放在
// classifyEmbeddingFailure 的表驱动用例与 app 侧 knowledge-store.test.ts。
vi.mock('fastembed', async () => {
  throw new Error("Cannot find module '@anush008/tokenizers-linux-arm64-gnu'");
});

const { probeLocalEmbeddingSupport } = await import('../src/embeddings.js');

describe('probeLocalEmbeddingSupport', () => {
  it('导入期失败 → supported:false，并带回一条非空错误', async () => {
    const result = await probeLocalEmbeddingSupport();

    expect(result.supported).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
