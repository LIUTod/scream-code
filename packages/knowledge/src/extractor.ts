import type { ChunkSection, ExtractedEntity, ExtractedEvent, LlmCaller } from './types.js';

export const ENTITY_TYPES = [
  'person',
  'organization',
  'location',
  'time',
  'product',
  'metric',
  'action',
  'work',
  'group',
  'subject',
  'tags',
] as const;

export const EXTRACTION_SYSTEM_PROMPT = `You are a professional knowledge content extractor for a SAG-style event-centric knowledge graph.

Your task: given a markdown section (one chunk), extract exactly ONE fused event that captures the section's core informational content, plus the entities mentioned.

# Output Format

Return a JSON object with this exact shape:

{
  "items": [
    {
      "title": "short event title (≤80 chars, noun phrase or short sentence)",
      "summary": "one-sentence summary of what this section is about",
      "content": "the full informational content of this section, rephrased as a self-contained event description (1-4 sentences)",
      "category": "one of: definition, process, comparison, decision, history, reference, other",
      "keywords": ["3-5 short keywords or phrases"],
      "entities": [
        { "type": "one of ENTITY_TYPES below", "name": "entity name", "description": "one-line context for the entity" }
      ]
    }
  ]
}

# Entity Types

Use only these types:
- person — named individuals
- organization — companies, teams, institutions
- location — places, geographic regions
- time — dates, time periods, eras
- product — products, services, software, tools
- metric — numbers, statistics, measurements
- action — processes, operations, activities
- work — books, papers, projects, artworks
- group — categories, classes, groups of things
- subject — abstract topics, concepts, fields
- tags — use sparingly for cross-cutting labels

# Rules

1. Produce EXACTLY ONE item in the "items" array.
2. The event title should be specific enough to disambiguate from sibling sections.
3. The content must be self-contained — a reader should understand it without the surrounding context.
4. Extract 2-6 entities per chunk. Only include entities that are clearly referenced in the text.
5. Use the entity's most specific name (e.g. "Anthropic" rather than "the company").
6. Output language must follow the main input language. Chinese input requires Chinese title, summary, content, category, keywords, and entity descriptions. English input requires English fields.
7. Output ONLY the JSON object — no prose, no markdown fences, no commentary.

# Example

Input section:
"""
## Model Context Protocol

The Model Context Protocol (MCP) is an open standard introduced by Anthropic in 2024. It defines a JSON-RPC interface between AI assistants and external tools. MCP servers expose resources, prompts, and tools that clients like Claude Desktop can consume.
"""

Output:
{
  "items": [
    {
      "title": "Model Context Protocol introduction",
      "summary": "MCP is an open standard for AI assistant / tool integration introduced by Anthropic in 2024.",
      "content": "The Model Context Protocol (MCP) is an open standard introduced by Anthropic in 2024 that defines a JSON-RPC interface between AI assistants and external tools. MCP servers expose resources, prompts, and tools that clients like Claude Desktop can consume.",
      "category": "definition",
      "keywords": ["MCP", "JSON-RPC", "Anthropic", "AI tools"],
      "entities": [
        { "type": "product", "name": "Model Context Protocol", "description": "Open standard for AI assistant / tool integration" },
        { "type": "organization", "name": "Anthropic", "description": "Company that introduced MCP in 2024" },
        { "type": "time", "name": "2024", "description": "Year MCP was introduced" },
        { "type": "product", "name": "Claude Desktop", "description": "An MCP client application" }
      ]
    }
  ]
}`;

/**
 * Build the user prompt for extracting events/entities from a chunk.
 * Includes a one-shot example to anchor the expected output shape.
 */
export function buildExtractionUserPrompt(chunk: ChunkSection): string {
  const heading = chunk.heading ?? '(no heading)';
  return [
    'Extract the fused event and entities from the following markdown section.',
    '',
    `Section heading: ${heading}`,
    '',
    'Section content:',
    '"""',
    chunk.content,
    '"""',
    '',
    'Return only the JSON object per the schema.',
  ].join('\n');
}

/** Extract the first {...} JSON block from a text response. */
export function extractJsonFromText(text: string): string | null {
  const match = text.match(/\{[\s\S]*\}/);
  return match === null ? null : match[0];
}

/** Parse LLM extraction output into structured events. Returns at most 1 event. */
export function parseExtractionResponse(
  text: string,
  fallbackChunk: ChunkSection,
): ExtractedEvent {
  const jsonText = extractJsonFromText(text);
  if (jsonText === null) {
    return fallbackEvent(fallbackChunk);
  }
  try {
    const parsed = JSON.parse(jsonText) as { items?: unknown };
    const items = parsed['items'];
    if (!Array.isArray(items) || items.length === 0) {
      return fallbackEvent(fallbackChunk);
    }
    const first = items[0];
    if (first === null || typeof first !== 'object') {
      return fallbackEvent(fallbackChunk);
    }
    const obj = first as Record<string, unknown>;
    const title = typeof obj['title'] === 'string' && obj['title'].trim().length > 0
      ? obj['title'].trim()
      : fallbackChunk.heading ?? 'Untitled';
    const summary = typeof obj['summary'] === 'string' ? obj['summary'].trim() : '';
    const content = typeof obj['content'] === 'string' && obj['content'].trim().length > 0
      ? obj['content'].trim()
      : fallbackChunk.content;
    const category = typeof obj['category'] === 'string' ? obj['category'].trim() : 'other';
    const keywords = parseKeywords(obj['keywords']);
    const entities = parseEntities(obj['entities']);
    return { title, summary, content, category, keywords, entities };
  } catch {
    return fallbackEvent(fallbackChunk);
  }
}

function parseKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) {
      out.push(item.trim());
    }
  }
  return out.slice(0, 10);
}

function parseEntities(value: unknown): ExtractedEntity[] {
  if (!Array.isArray(value)) return [];
  const out: ExtractedEntity[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const type = typeof obj['type'] === 'string' ? obj['type'] : '';
    const name = typeof obj['name'] === 'string' ? obj['name'].trim() : '';
    const description = typeof obj['description'] === 'string' ? obj['description'].trim() : '';
    if (name.length === 0) continue;
    if (!ENTITY_TYPES.includes(type as (typeof ENTITY_TYPES)[number])) continue;
    const key = `${type}|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: type as ExtractedEntity['type'], name, description });
  }
  return out.slice(0, 20);
}

function fallbackEvent(chunk: ChunkSection): ExtractedEvent {
  return {
    title: chunk.heading ?? 'Untitled section',
    summary: '',
    content: chunk.content,
    category: 'other',
    keywords: [],
    entities: [],
  };
}

/**
 * Run extraction on a single chunk via the LLM caller.
 * Returns the parsed event (with fallback on failure).
 */
export async function extractEventFromChunk(
  llm: LlmCaller,
  chunk: ChunkSection,
): Promise<ExtractedEvent> {
  try {
    const response = await llm.generate(
      EXTRACTION_SYSTEM_PROMPT,
      buildExtractionUserPrompt(chunk),
    );
    return parseExtractionResponse(response, chunk);
  } catch {
    return fallbackEvent(chunk);
  }
}

/**
 * Ask the LLM to rerank candidate events by relevance to a query.
 * Returns the candidate ids in reranked order (most relevant first).
 *
 * If the LLM fails or returns unparseable output, returns the input order.
 */
export async function rerankEventsWithLlm(
  llm: LlmCaller,
  query: string,
  candidates: Array<{ id: string; title: string; summary: string }>,
  topK: number,
): Promise<string[]> {
  if (candidates.length === 0) return [];
  if (candidates.length <= topK) return candidates.map((c) => c.id);

  const candidateList = candidates
    .map((c, i) => `[${i}] id=${c.id}\n    title: ${c.title}\n    summary: ${c.summary}`)
    .join('\n');

  const system = `You are a precise relevance judge for a knowledge base retrieval system.

Given a user query and a list of candidate events, select the ${topK} event ids most useful for answering the query.

Return ONLY a JSON object: {"ids": ["id1", "id2", ...]}

The ids must come from the candidate list. Output at most ${topK} ids, most relevant first. No prose, no markdown.`;

  const user = `Query: ${query}

Candidates:
${candidateList}

Return the JSON object now.`;

  try {
    const response = await llm.generate(system, user);
    const jsonText = extractJsonFromText(response);
    if (jsonText === null) return candidates.slice(0, topK).map((c) => c.id);
    const parsed = JSON.parse(jsonText) as { ids?: unknown };
    if (!Array.isArray(parsed['ids'])) return candidates.slice(0, topK).map((c) => c.id);
    const validIds = new Set(candidates.map((c) => c.id));
    const result: string[] = [];
    for (const id of parsed['ids']) {
      if (typeof id === 'string' && validIds.has(id) && !result.includes(id)) {
        result.push(id);
      }
      if (result.length >= topK) break;
    }
    if (result.length === 0) return candidates.slice(0, topK).map((c) => c.id);
    return result;
  } catch {
    return candidates.slice(0, topK).map((c) => c.id);
  }
}

/**
 * Extract named entities from a query for entity-recall retrieval.
 * Returns a list of {type, name} pairs. Best-effort — falls back to empty.
 */
export async function extractQueryEntities(
  llm: LlmCaller,
  query: string,
): Promise<Array<{ type: string; name: string }>> {
  const system = `Extract named entities from the user query. Return ONLY a JSON object: {"entities": [{"type": "...", "name": "..."}]}

Use these entity types: ${ENTITY_TYPES.join(', ')}.

Only include entities that explicitly appear in the query. If no clear entities, return an empty array.`;

  try {
    const response = await llm.generate(system, `Query: ${query}`);
    const jsonText = extractJsonFromText(response);
    if (jsonText === null) return [];
    const parsed = JSON.parse(jsonText) as { entities?: unknown };
    if (!Array.isArray(parsed['entities'])) return [];
    const out: Array<{ type: string; name: string }> = [];
    for (const item of parsed['entities']) {
      if (item === null || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const type = typeof obj['type'] === 'string' ? obj['type'] : '';
      const name = typeof obj['name'] === 'string' ? obj['name'].trim() : '';
      if (name.length === 0) continue;
      if (!ENTITY_TYPES.includes(type as (typeof ENTITY_TYPES)[number])) continue;
      out.push({ type, name });
    }
    return out;
  } catch {
    return [];
  }
}
