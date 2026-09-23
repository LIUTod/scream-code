import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '#/agent';
import type { ExecutableToolContext } from '#/loop/types';
import { KnowledgeLookupTool } from '#/tools/builtin/knowledge/knowledge-lookup';

const knowledgePkg = vi.hoisted(() => ({
  multiSearchWithTrace: vi.fn(),
}));

vi.mock('@scream-code/knowledge', () => knowledgePkg);

afterEach(() => {
  vi.clearAllMocks();
});

function makeAgent(opts: {
  chunks: number;
  cacheDir: string;
  available?: boolean;
}) {
  const ensureReady = vi.fn(async (): Promise<boolean> => true);
  const engine = {
    available: opts.available ?? false,
    ensureReady,
    modelName: 'fast-bge-small-zh-v1.5',
    embedBatch: vi.fn(),
    cosineSimilarity: vi.fn(),
  };
  const store = {
    stats: vi.fn(async () => ({ chunks: opts.chunks })),
    getEmbeddingEngine: vi.fn(() => engine),
  };
  const agent = {
    knowledgeStore: store,
    embeddingCacheDir: opts.cacheDir,
    generateText: vi.fn(async () => 'ok'),
  } as unknown as Agent;
  return { agent, store, engine, ensureReady };
}

function mockResults() {
  knowledgePkg.multiSearchWithTrace.mockResolvedValue({
    results: [
      {
        chunkId: 'c1',
        documentId: 'd1',
        sourceId: 's1',
        sourceName: 'doc.md',
        heading: 'Heading',
        content: 'Body',
        score: 0.91,
        eventId: 'e1',
        eventTitle: 'Event',
      },
    ],
    trace: { steps: [], rerankedEventTitles: [], fallbackReason: null },
  });
}

function writeModelCache(cacheDir: string): void {
  const modelDir = join(cacheDir, 'fast-bge-small-zh-v1.5');
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, 'model_optimized.onnx'), new Uint8Array([1, 2, 3]));
}

const ctx = { turnId: 't', toolCallId: 'c', signal: undefined } as unknown as ExecutableToolContext;

async function run(agent: Agent, args: Record<string, unknown> = {}) {
  const tool = new KnowledgeLookupTool(agent);
  const execution = tool.resolveExecution({ query: 'what is rust', ...args });
  if ('execute' in execution) return await execution.execute(ctx);
  return execution;
}

describe('KnowledgeLookupTool — fast path, warm-up, deep flag', () => {
  it('fast by default: passes skipLlm:true and never calls the LLM on this path', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'kl-nocache-'));
    const { agent } = makeAgent({ chunks: 3, cacheDir, available: true });
    mockResults();

    const out = await run(agent);

    expect(out.isError).toBe(false);
    const options = knowledgePkg.multiSearchWithTrace.mock.calls[0]![3] as {
      skipLlm?: boolean;
      topK: number;
    };
    expect(options.skipLlm).toBe(true);
    expect(typeof options.topK).toBe('number');
  });

  it('deep:true flips the search to the LLM path', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'kl-deep-'));
    const { agent } = makeAgent({ chunks: 3, cacheDir, available: true });
    mockResults();

    await run(agent, { deep: true });

    const options = knowledgePkg.multiSearchWithTrace.mock.calls[0]![3] as {
      skipLlm?: boolean;
    };
    expect(options.skipLlm).toBe(false);
  });

  it('no model cache: does not call ensureReady (no surprise download) and shows the hint', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'kl-noload-'));
    const { agent, ensureReady } = makeAgent({ chunks: 3, cacheDir, available: false });
    mockResults();

    const out = await run(agent);

    expect(ensureReady).not.toHaveBeenCalled();
    expect(out.output).toContain('Vector model not loaded');
    expect(out.output).toContain('/knowledge');
  });

  it('model cache present: warms the engine once via ensureReady', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'kl-warm-'));
    writeModelCache(cacheDir);
    const { agent, ensureReady } = makeAgent({ chunks: 3, cacheDir, available: false });
    mockResults();

    const out = await run(agent);

    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(out.isError).toBe(false);
  });

  it('ready engine: no warm-up needed and no degraded hint', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'kl-ready-'));
    const { agent, ensureReady } = makeAgent({ chunks: 3, cacheDir, available: true });
    mockResults();

    const out = await run(agent);

    expect(ensureReady).not.toHaveBeenCalled();
    expect(out.output).not.toContain('Vector model not loaded');
    expect(out.output).toContain('Found 1 relevant knowledge chunk');
  });

  it('empty store returns the actionable English message', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'kl-empty-'));
    const { agent } = makeAgent({ chunks: 0, cacheDir });

    const out = await run(agent);

    expect(out.isError).toBe(false);
    expect(out.output).toMatch(/Knowledge base is empty/);
    expect(out.output).not.toContain('知识库');
    expect(knowledgePkg.multiSearchWithTrace).not.toHaveBeenCalled();
  });
});
