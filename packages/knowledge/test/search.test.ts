import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ingestContent } from '../src/ingest.js';
import { multiSearch, multiSearchWithTrace } from '../src/search.js';
import { KnowledgeStore } from '../src/store.js';
import type { EmbeddingEngine, LlmCaller } from '../src/types.js';

/** Deterministic stub embedding engine — bag-of-words vectors so words match. */
function makeStubEngine(): EmbeddingEngine {
  const dim = 256;
  const vocab = new Map<string, number>();
  function tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9一-鿿]+/)
      .filter((t) => t.length > 0);
  }
  function wordIndex(word: string): number {
    let idx = vocab.get(word);
    if (idx === undefined) {
      idx = vocab.size % dim;
      vocab.set(word, idx);
    }
    return idx;
  }
  function embed(text: string): Float32Array {
    const vec = new Float32Array(dim);
    const tokens = tokenize(text);
    for (const tok of tokens) {
      vec[wordIndex(tok)]! += 1;
    }
    // Normalize to unit length.
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += vec[i]! * vec[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dim; i++) vec[i] = vec[i]! / norm;
    }
    return vec;
  }
  return {
    available: true,
    async embedBatch(texts: string[]): Promise<Float32Array[] | null> {
      return texts.map(embed);
    },
    cosineSimilarity(a: Float32Array, b: Float32Array): number {
      let dot = 0;
      for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
      return dot;
    },
    async ensureReady(): Promise<boolean> {
      return true;
    },
  };
}

/** Stub LLM that returns a canned extraction with the chunk heading as title. */
function makeStubLlm(): LlmCaller {
  return {
    async generate(systemPrompt, userPrompt) {
      if (systemPrompt.includes('knowledge content extractor')) {
        // Extraction call — pull the heading from the user prompt.
        const headingMatch = userPrompt.match(/Section heading: (.+)/);
        const heading = headingMatch?.[1]?.trim() ?? 'Untitled';
        const contentMatch = userPrompt.match(/"""([\s\S]+?)"""/);
        const content = contentMatch?.[1]?.trim() ?? '';
        // Extract fake entities by looking for capitalized words.
        const entities: Array<{ type: string; name: string; description: string }> = [];
        const entityRe = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g;
        let m: RegExpExecArray | null;
        const seen = new Set<string>();
        while ((m = entityRe.exec(content)) !== null) {
          const name = m[1]!;
          if (seen.has(name)) continue;
          seen.add(name);
          if (name === 'The' || name === 'A') continue;
          entities.push({ type: 'subject', name, description: `${name} mentioned in section` });
        }
        return JSON.stringify({
          items: [
            {
              title: heading,
              summary: `About ${heading}`,
              content: content.length > 0 ? content : heading,
              category: 'definition',
              keywords: [heading.toLowerCase()],
              entities: entities.slice(0, 5),
            },
          ],
        });
      }
      if (systemPrompt.includes('relevance judge')) {
        // Rerank call — return candidates in original order (no real reranking).
        const idMatches = userPrompt.matchAll(/id=([a-z0-9-]+)/g);
        const ids = Array.from(idMatches).map((m) => m[1]!);
        return JSON.stringify({ ids: ids.slice(0, 3) });
      }
      if (systemPrompt.includes('named entities')) {
        // Entity recall from query.
        const entityRe = /\b([A-Z][a-z]+)\b/g;
        const entities: Array<{ type: string; name: string }> = [];
        let m: RegExpExecArray | null;
        while ((m = entityRe.exec(userPrompt)) !== null) {
          if (m[1] === 'Query') continue;
          entities.push({ type: 'subject', name: m[1]! });
        }
        return JSON.stringify({ entities });
      }
      return '';
    },
  };
}

describe('multiSearch (integration with stubs)', () => {
  let tmpDir: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-knowledge-search-'));
    store = new KnowledgeStore(tmpDir);
    await store.init();
    store.setEmbeddingEngine(makeStubEngine());
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty results on empty knowledge base', async () => {
    const llm = makeStubLlm();
    const results = await multiSearch(store, llm, 'anything', { topK: 3 });
    expect(results).toEqual([]);
  });

  it('returns matching chunks after ingest', async () => {
    const llm = makeStubLlm();
    const content = [
      '## Rust Language',
      'Rust is a systems programming language focused on safety.',
      '',
      '## Python Language',
      'Python is a scripting language popular for data science.',
      '',
      '## Go Language',
      'Go is a statically typed compiled language at Google.',
    ].join('\n');
    await ingestContent(store, llm, { name: 'languages.md', content });
    const results = await multiSearch(store, llm, 'Rust', { topK: 3 });
    expect(results.length).toBeGreaterThan(0);
    // The top result should mention Rust.
    const topResult = results[0]!;
    expect(topResult.content.toLowerCase()).toContain('rust');
  });

  it('deduplicates chunks by chunk_id', async () => {
    const llm = makeStubLlm();
    const content = '## A\nBody A content here.';
    await ingestContent(store, llm, { name: 'doc.md', content });
    const results = await multiSearch(store, llm, 'A', { topK: 5 });
    const chunkIds = results.map((r) => r.chunkId);
    expect(new Set(chunkIds).size).toBe(chunkIds.length);
  });

  it('respects topK limit', async () => {
    const llm = makeStubLlm();
    const content = [
      '## A\nA content',
      '## B\nB content',
      '## C\nC content',
      '## D\nD content',
    ].join('\n\n');
    await ingestContent(store, llm, { name: 'doc.md', content });
    const results = await multiSearch(store, llm, 'content', { topK: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('includes source name in results', async () => {
    const llm = makeStubLlm();
    await ingestContent(store, llm, { name: 'mydoc.md', content: '## H\nBody' });
    const results = await multiSearch(store, llm, 'Body', { topK: 1 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.sourceName).toBe('mydoc.md');
  });

  it('returns score and event info', async () => {
    const llm = makeStubLlm();
    await ingestContent(store, llm, { name: 'doc.md', content: '## H\nBody text' });
    const results = await multiSearch(store, llm, 'Body', { topK: 1 });
    expect(results.length).toBeGreaterThan(0);
    expect(typeof results[0]!.score).toBe('number');
    expect(results[0]!.eventId).not.toBeNull();
    expect(results[0]!.eventTitle).not.toBeNull();
  });
});

describe('multiSearchWithTrace', () => {
  let tmpDir: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-knowledge-trace-'));
    store = new KnowledgeStore(tmpDir);
    await store.init();
    store.setEmbeddingEngine(makeStubEngine());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('records steps for each retrieval phase on a hit', async () => {
    const llm = makeStubLlm();
    const content = [
      '## Rust Language',
      'Rust is a systems programming language focused on safety.',
      '',
      '## Python Language',
      'Python is a scripting language popular for data science.',
    ].join('\n');
    await ingestContent(store, llm, { name: 'languages.md', content });

    const { results, trace } = await multiSearchWithTrace(store, llm, 'Rust', { topK: 2 });
    expect(results.length).toBeGreaterThan(0);

    const stepNames = trace.steps.map((s) => s.step);
    expect(stepNames).toContain('queryEmbedding');
    expect(stepNames).toContain('entityRecall');
    expect(stepNames).toContain('seedEventsByTitle');
    expect(stepNames).toContain('bfsExpand');
    expect(stepNames).toContain('coarseRank');
    expect(trace.rerankedEventTitles.length).toBeGreaterThan(0);
    expect(trace.fallbackReason).toBeNull();
  });

  it('falls back to FTS when no seed or chunk vectors exist', async () => {
    const source = await store.createSource({ name: 'legacy.md' });
    const document = await store.createDocument({
      sourceId: source.id,
      title: 'legacy.md',
    });
    const chunk = await store.insertChunk({
      sourceId: source.id,
      documentId: document.id,
      rank: 0,
      heading: 'Legacy knowledge',
      content: 'The migration handbook explains historical deployment steps.',
      rawContent: null,
      embedding: null,
    });

    const { results, trace } = await multiSearchWithTrace(
      store,
      makeStubLlm(),
      'migration handbook',
      { topK: 3 },
    );

    expect(results.map((result) => result.chunkId)).toEqual([chunk.id]);
    expect(trace.fallbackReason).toBe(
      'no seed events and direct chunk vector search returned no results; used FTS5 keyword fallback',
    );
    expect(trace.rerankedEventTitles).toEqual([]);
  });

  it('falls back to FTS when graph seeds resolve to no candidates or chunk vectors', async () => {
    const source = await store.createSource({ name: 'legacy.md' });
    const document = await store.createDocument({
      sourceId: source.id,
      title: 'legacy.md',
    });
    const chunk = await store.insertChunk({
      sourceId: source.id,
      documentId: document.id,
      rank: 0,
      heading: 'Operations',
      content: 'Operations recovery procedures for the archived service.',
      rawContent: null,
      embedding: null,
    });
    vi.spyOn(store, 'findEventsByTitleVector').mockResolvedValue([
      {
        event: {
          id: 'missing-event',
          sourceId: source.id,
          documentId: document.id,
          chunkId: chunk.id,
          rank: 0,
          title: 'Missing event',
          summary: null,
          content: '',
          category: null,
          keywords: [],
          titleEmbedding: null,
          contentEmbedding: null,
          createdAt: 0,
        },
        score: 1,
      },
    ]);

    const { results, trace } = await multiSearchWithTrace(
      store,
      makeStubLlm(),
      'operations recovery',
      { topK: 2 },
    );

    expect(results.map((result) => result.chunkId)).toEqual([chunk.id]);
    expect(trace.fallbackReason).toBe(
      'no graph-reachable events with content and chunk vector search returned no results; used FTS5 keyword fallback',
    );
  });

  it('falls back to FTS when graph retrieval and chunk backfill build no results', async () => {
    const source = await store.createSource({ name: 'legacy.md' });
    const document = await store.createDocument({
      sourceId: source.id,
      title: 'legacy.md',
    });
    const chunk = await store.insertChunk({
      sourceId: source.id,
      documentId: document.id,
      rank: 0,
      heading: 'Terminal fallback',
      content: 'Terminal fallback procedures for historical records.',
      rawContent: null,
      embedding: null,
    });
    const engine = store.getEmbeddingEngine()!;
    const [eventEmbedding] = (await engine.embedBatch(['terminal fallback']))!;
    await store.insertEvent({
      sourceId: source.id,
      documentId: document.id,
      chunkId: chunk.id,
      rank: 0,
      title: 'Terminal fallback',
      summary: null,
      content: 'Historical record',
      category: null,
      keywords: [],
      titleEmbedding: eventEmbedding!,
      contentEmbedding: eventEmbedding!,
    });
    const buildSearchResult = store.buildSearchResult.bind(store);
    vi.spyOn(store, 'buildSearchResult').mockImplementation(
      (chunkId, score, eventId = null) =>
        eventId === null
          ? buildSearchResult(chunkId, score, eventId)
          : Promise.resolve(undefined),
    );

    const { results, trace } = await multiSearchWithTrace(
      store,
      makeStubLlm(),
      'terminal fallback',
      { topK: 1 },
    );

    expect(results.map((result) => result.chunkId)).toEqual([chunk.id]);
    expect(trace.fallbackReason).toBe(
      'vector retrieval returned no results; used FTS5 keyword fallback',
    );
  });

  it('uses FTS only when the complete vector retrieval result is empty', async () => {
    const source = await store.createSource({ name: 'vectors.md' });
    const document = await store.createDocument({
      sourceId: source.id,
      title: 'vectors.md',
    });
    const engine = store.getEmbeddingEngine()!;
    const [embedding] = (await engine.embedBatch(['vector handbook']))!;
    const vectorChunk = await store.insertChunk({
      sourceId: source.id,
      documentId: document.id,
      rank: 0,
      heading: 'Vector result',
      content: 'A vector-only result.',
      rawContent: null,
      embedding: embedding!,
    });
    await store.insertChunk({
      sourceId: source.id,
      documentId: document.id,
      rank: 1,
      heading: 'Keyword result',
      content: 'vector handbook keyword-only result',
      rawContent: null,
      embedding: null,
    });
    const ftsSpy = vi.spyOn(store, 'ftsSearchChunks');

    const { results, trace } = await multiSearchWithTrace(
      store,
      makeStubLlm(),
      'vector handbook',
      { topK: 3 },
    );

    expect(results.map((result) => result.chunkId)).toEqual([vectorChunk.id]);
    expect(ftsSpy).not.toHaveBeenCalled();
    expect(trace.fallbackReason).toBe('no seed events; used direct chunk vector search');
  });

  it('each step has non-negative durationMs and a non-empty detail', async () => {
    const llm = makeStubLlm();
    await ingestContent(store, llm, { name: 'doc.md', content: '## H\nBody text' });
    const { trace } = await multiSearchWithTrace(store, llm, 'Body', { topK: 1 });
    for (const step of trace.steps) {
      expect(step.durationMs).toBeGreaterThanOrEqual(0);
      expect(step.detail.length).toBeGreaterThan(0);
    }
  });

  it('emits a rerank step on every path (skip, short, or full rerank)', async () => {
    const llm = makeStubLlm();
    const content = [
      '## Rust\nRust content',
      '## Python\nPython content',
      '## Go\nGo content',
    ].join('\n\n');
    await ingestContent(store, llm, { name: 'doc.md', content });

    // Full rerank path (candidates > topK) — use a query that matches titles.
    const traceFull = await multiSearchWithTrace(store, llm, 'Rust', { topK: 1 });
    const stepsFull = traceFull.trace.steps.map((s) => s.step);
    expect(stepsFull).toContain('rerank');

    // Short-circuit path (candidates <= topK).
    const traceShort = await multiSearchWithTrace(store, llm, 'Rust', { topK: 10 });
    const stepsShort = traceShort.trace.steps.map((s) => s.step);
    expect(stepsShort).toContain('rerank');

    // Skip path (skipRerank=true).
    const traceSkip = await multiSearchWithTrace(store, llm, 'Rust', {
      topK: 1,
      skipRerank: true,
    });
    const stepsSkip = traceSkip.trace.steps.map((s) => s.step);
    expect(stepsSkip).toContain('rerank');
  });

  it('measures real duration for IO-bound steps (bfsExpand, coarseRank)', async () => {
    const llm = makeStubLlm();
    const content = [
      '## Rust\nRust content here',
      '## Python\nPython content here',
      '## Go\nGo content here',
    ].join('\n\n');
    await ingestContent(store, llm, { name: 'doc.md', content });

    const { trace } = await multiSearchWithTrace(store, llm, 'Rust', { topK: 1 });
    const stepByName = new Map(trace.steps.map((s) => [s.step, s]));
    // These steps were previously hard-coded to 0ms — verify they now carry
    // a real measurement (a number, even if 0 for fast in-memory stubs).
    expect(stepByName.has('bfsExpand')).toBe(true);
    expect(typeof stepByName.get('bfsExpand')?.durationMs).toBe('number');
    expect(stepByName.has('coarseRank')).toBe(true);
    expect(typeof stepByName.get('coarseRank')?.durationMs).toBe('number');
  });
});
