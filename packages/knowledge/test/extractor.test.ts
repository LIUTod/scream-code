import { describe, expect, it } from 'vitest';

import {
  ENTITY_TYPES,
  extractJsonFromText,
  parseExtractionResponse,
  rerankEventsWithLlm,
  extractQueryEntities,
  extractEventFromChunk,
  type LlmCaller,
} from '../src/index.js';
import type { ChunkSection } from '../src/types.js';

function makeChunk(overrides: Partial<ChunkSection> = {}): ChunkSection {
  return {
    heading: 'Test heading',
    headingLevel: 2,
    content: 'Test content',
    rawContent: 'Test content',
    rank: 0,
    ...overrides,
  };
}

describe('extractJsonFromText', () => {
  it('extracts the first JSON object', () => {
    const text = 'some preamble\n{"a": 1}\ntrailer';
    expect(extractJsonFromText(text)).toBe('{"a": 1}');
  });

  it('returns null when no JSON object is present', () => {
    expect(extractJsonFromText('no json here')).toBeNull();
  });

  it('handles nested objects', () => {
    const text = '{"a": {"b": 2}}';
    expect(extractJsonFromText(text)).toBe('{"a": {"b": 2}}');
  });
});

describe('parseExtractionResponse', () => {
  it('parses a well-formed response', () => {
    const text = JSON.stringify({
      items: [
        {
          title: 'My event',
          summary: 'A summary',
          content: 'The content',
          category: 'definition',
          keywords: ['a', 'b'],
          entities: [
            { type: 'person', name: 'Alice', description: 'A person' },
            { type: 'organization', name: 'Acme', description: 'A company' },
          ],
        },
      ],
    });
    const event = parseExtractionResponse(text, makeChunk());
    expect(event.title).toBe('My event');
    expect(event.summary).toBe('A summary');
    expect(event.content).toBe('The content');
    expect(event.category).toBe('definition');
    expect(event.keywords).toEqual(['a', 'b']);
    expect(event.entities).toHaveLength(2);
    expect(event.entities[0]!.name).toBe('Alice');
  });

  it('falls back to heading + content on parse failure', () => {
    const event = parseExtractionResponse('not json at all', makeChunk({ heading: 'H', content: 'C' }));
    expect(event.title).toBe('H');
    expect(event.content).toBe('C');
    expect(event.entities).toEqual([]);
  });

  it('falls back when items array is empty', () => {
    const event = parseExtractionResponse('{"items": []}', makeChunk({ heading: 'H', content: 'C' }));
    expect(event.title).toBe('H');
    expect(event.content).toBe('C');
  });

  it('filters out invalid entity types', () => {
    const text = JSON.stringify({
      items: [
        {
          title: 'T',
          summary: '',
          content: 'C',
          category: 'other',
          keywords: [],
          entities: [
            { type: 'person', name: 'Alice', description: '' },
            { type: 'invalid', name: 'X', description: '' },
          ],
        },
      ],
    });
    const event = parseExtractionResponse(text, makeChunk());
    expect(event.entities).toHaveLength(1);
    expect(event.entities[0]!.name).toBe('Alice');
  });

  it('deduplicates entities by type+name', () => {
    const text = JSON.stringify({
      items: [
        {
          title: 'T',
          summary: '',
          content: 'C',
          category: 'other',
          keywords: [],
          entities: [
            { type: 'person', name: 'Alice', description: 'first' },
            { type: 'person', name: 'alice', description: 'dup' },
          ],
        },
      ],
    });
    const event = parseExtractionResponse(text, makeChunk());
    expect(event.entities).toHaveLength(1);
  });

  it('uses fallback title when missing', () => {
    const text = JSON.stringify({
      items: [
        {
          summary: '',
          content: 'C',
          category: '',
          keywords: [],
          entities: [],
        },
      ],
    });
    const event = parseExtractionResponse(text, makeChunk({ heading: 'My heading', content: 'C' }));
    expect(event.title).toBe('My heading');
  });
});

describe('ENTITY_TYPES', () => {
  it('has 11 types', () => {
    expect(ENTITY_TYPES).toHaveLength(11);
  });

  it('includes person, organization, location', () => {
    expect(ENTITY_TYPES).toContain('person');
    expect(ENTITY_TYPES).toContain('organization');
    expect(ENTITY_TYPES).toContain('location');
  });
});

describe('extractEventFromChunk', () => {
  it('uses LLM response when valid', async () => {
    const llm: LlmCaller = {
      async generate() {
        return JSON.stringify({
          items: [
            {
              title: 'LLM title',
              summary: 's',
              content: 'c',
              category: 'definition',
              keywords: ['k'],
              entities: [{ type: 'person', name: 'Alice', description: 'd' }],
            },
          ],
        });
      },
    };
    const event = await extractEventFromChunk(llm, makeChunk());
    expect(event.title).toBe('LLM title');
    expect(event.entities[0]!.name).toBe('Alice');
  });

  it('falls back when LLM throws', async () => {
    const llm: LlmCaller = {
      async generate() {
        throw new Error('LLM unavailable');
      },
    };
    const event = await extractEventFromChunk(llm, makeChunk({ heading: 'H', content: 'C' }));
    expect(event.title).toBe('H');
    expect(event.content).toBe('C');
  });

  it('retries with backoff on transient failure then succeeds', async () => {
    let calls = 0;
    const llm: LlmCaller = {
      async generate() {
        calls += 1;
        if (calls < 3) throw new Error('transient');
        return JSON.stringify({
          items: [
            {
              title: 'Recovered',
              summary: 's',
              content: 'c',
              category: 'definition',
              keywords: [],
              entities: [],
            },
          ],
        });
      },
    };
    const event = await extractEventFromChunk(llm, makeChunk());
    expect(calls).toBe(3);
    expect(event.title).toBe('Recovered');
  });

  it('falls back after exhausting retries', async () => {
    let calls = 0;
    const llm: LlmCaller = {
      async generate() {
        calls += 1;
        throw new Error('persistent');
      },
    };
    const event = await extractEventFromChunk(llm, makeChunk({ heading: 'H', content: 'C' }));
    expect(calls).toBe(3);
    expect(event.title).toBe('H');
  });
});

describe('rerankEventsWithLlm', () => {
  it('returns LLM-selected ids in order', async () => {
    const llm: LlmCaller = {
      async generate(system, user) {
        expect(system).toContain('2');
        expect(user).toContain('Query: my query');
        return JSON.stringify({ ids: ['c', 'a'] });
      },
    };
    const candidates = [
      { id: 'a', title: 'A', summary: 'sa' },
      { id: 'b', title: 'B', summary: 'sb' },
      { id: 'c', title: 'C', summary: 'sc' },
    ];
    const ranked = await rerankEventsWithLlm(llm, 'my query', candidates, 2);
    expect(ranked).toEqual(['c', 'a']);
  });

  it('returns top-K of input order when LLM fails', async () => {
    const llm: LlmCaller = {
      async generate() {
        throw new Error('fail');
      },
    };
    const candidates = [
      { id: 'a', title: 'A', summary: '' },
      { id: 'b', title: 'B', summary: '' },
      { id: 'c', title: 'C', summary: '' },
    ];
    const ranked = await rerankEventsWithLlm(llm, 'q', candidates, 2);
    expect(ranked).toEqual(['a', 'b']);
  });

  it('filters out invalid ids from LLM response', async () => {
    const llm: LlmCaller = {
      async generate() {
        return JSON.stringify({ ids: ['a', 'invalid-id', 'b'] });
      },
    };
    const candidates = [
      { id: 'a', title: 'A', summary: '' },
      { id: 'b', title: 'B', summary: '' },
    ];
    const ranked = await rerankEventsWithLlm(llm, 'q', candidates, 2);
    expect(ranked).toEqual(['a', 'b']);
  });

  it('returns input order when candidates length ≤ topK', async () => {
    const llm: LlmCaller = { async generate() { return ''; } };
    const candidates = [
      { id: 'a', title: 'A', summary: '' },
      { id: 'b', title: 'B', summary: '' },
    ];
    const ranked = await rerankEventsWithLlm(llm, 'q', candidates, 5);
    expect(ranked).toEqual(['a', 'b']);
  });
});

describe('extractQueryEntities', () => {
  it('parses entities from LLM response', async () => {
    const llm: LlmCaller = {
      async generate() {
        return JSON.stringify({
          entities: [
            { type: 'person', name: 'Alice' },
            { type: 'organization', name: 'Acme' },
          ],
        });
      },
    };
    const entities = await extractQueryEntities(llm, "What about Alice at Acme?");
    expect(entities).toHaveLength(2);
    expect(entities[0]!.name).toBe('Alice');
  });

  it('returns empty array on LLM failure', async () => {
    const llm: LlmCaller = {
      async generate() { throw new Error('fail'); },
    };
    const entities = await extractQueryEntities(llm, 'query');
    expect(entities).toEqual([]);
  });

  it('filters out invalid entity types', async () => {
    const llm: LlmCaller = {
      async generate() {
        return JSON.stringify({
          entities: [
            { type: 'person', name: 'Alice' },
            { type: 'invalid', name: 'X' },
          ],
        });
      },
    };
    const entities = await extractQueryEntities(llm, 'q');
    expect(entities).toHaveLength(1);
  });
});
