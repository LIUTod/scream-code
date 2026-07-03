import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ingestContent } from '../src/ingest.js';
import { multiSearch } from '../src/search.js';
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
