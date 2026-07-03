import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'pathe';

import { chunkMarkdown, chunkText } from './chunking.js';
import { extractEventFromChunk } from './extractor.js';
import type { KnowledgeStore } from './store.js';
import type {
  ChunkSection,
  IngestProgress,
  IngestProgressCallback,
  KnowledgeEvent,
  LlmCaller,
} from './types.js';

const LLM_CONCURRENCY = 3;
const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

/** Read a file and return its content. */
async function readFileContent(filePath: string): Promise<string> {
  return readFile(filePath, 'utf-8');
}

function getFileExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  return lastDot > 0 ? filePath.slice(lastDot).toLowerCase() : '';
}

function chunkContent(content: string, ext: string): ChunkSection[] {
  return ext === '.txt' ? chunkText(content) : chunkMarkdown(content);
}

export function isSupportedFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(getFileExtension(filePath));
}

/** Map async iterator values with a concurrency limit. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (index: number, total: number, result: R) => void,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let cursor = 0;
  let completed = 0;
  const total = items.length;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      const item = items[idx]!;
      const result = await fn(item, idx);
      results[idx] = result;
      completed += 1;
      onProgress?.(completed, total, result);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Ingest a markdown file into the knowledge base.
 *
 * Steps:
 * 1. Dedupe by file_path — if a source already exists for this file, error.
 * 2. Read file → chunkMarkdown (heading_strict).
 * 3. Embed chunks ("{heading}\n{content}") → store knowledge_chunks.
 * 4. For each chunk (concurrency 3): LLM extract 1 event + N entities.
 * 5. Embed event title + content ("{title}\n\n{content}") → store knowledge_events.
 * 6. Upsert entities (dedupe by source_id+type+normalizedName) + embed entity name → store.
 * 7. For each (event, entity) pair: embed relation (entity.description || "{eventTitle} {entityName}") → store knowledge_event_entities.
 * 8. Update document status = 'completed'.
 *
 * All writes run inside a single transaction — a mid-ingest failure rolls back
 * every partial row (source/document/chunks/events/entities/edges).
 *
 * Reports progress via callback.
 */
export async function ingestFile(
  store: KnowledgeStore,
  llm: LlmCaller,
  filePath: string,
  onProgress?: IngestProgressCallback,
): Promise<{ documentId: string; chunkCount: number; eventCount: number; entityCount: number }> {
  const engine = store.getEmbeddingEngine();
  if (engine === undefined || !engine.available) {
    onProgress?.({ stage: 'error', message: 'embedding engine unavailable' });
    throw new Error('embedding engine unavailable — knowledge base requires fastembed');
  }

  // 1. Dedupe by file path.
  const existing = await store.findSourceByFilePath(filePath);
  if (existing !== undefined) {
    onProgress?.({
      stage: 'error',
      message: `文件已摄入：${existing.name}（source id=${existing.id}）`,
    });
    throw new Error(`file already ingested: ${filePath} (source ${existing.id})`);
  }

  // 2. Read + chunk.
  onProgress?.({ stage: 'chunking', message: `读取并切分文件: ${basename(filePath)}` });
  const content = await readFileContent(filePath);
  const sections = chunkContent(content, getFileExtension(filePath));
  if (sections.length === 0) {
    onProgress?.({ stage: 'error', message: '文件无有效内容' });
    throw new Error('file has no content to ingest');
  }

  store.beginTransaction();
  try {
    // 3. Create source + document.
    const fileName = basename(filePath);
    const source = await store.createSource({
      name: fileName,
      filePath,
      description: null,
    });
    const document = await store.createDocument({
      sourceId: source.id,
      title: fileName,
      content,
    });

    // 4. Embed chunks and store.
    onProgress?.({
      stage: 'embedding-chunks',
      chunkIndex: 0,
      totalChunks: sections.length,
      message: `嵌入 chunks: 0/${sections.length}`,
    });
    const chunkEmbeddings = await engine.embedBatch(
      sections.map((s) => (s.heading !== null ? `${s.heading}\n${s.content}` : s.content)),
    );
    if (chunkEmbeddings === null) {
      onProgress?.({ stage: 'error', message: 'chunk embedding failed' });
      throw new Error('chunk embedding failed');
    }

    const chunks = [];
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]!;
      const embedding = chunkEmbeddings[i] ?? null;
      const chunk = await store.insertChunk({
        sourceId: source.id,
        documentId: document.id,
        rank: section.rank,
        heading: section.heading,
        content: section.content,
        rawContent: section.rawContent,
        embedding,
      });
      chunks.push(chunk);
      onProgress?.({
        stage: 'embedding-chunks',
        chunkIndex: i + 1,
        totalChunks: sections.length,
        message: `嵌入 chunks: ${i + 1}/${sections.length}`,
      });
    }

    // 5. LLM extract events (concurrency 3).
    onProgress?.({
      stage: 'extracting',
      chunkIndex: 0,
      totalChunks: sections.length,
      message: `抽取事件: 0/${sections.length}`,
    });
    const extractedEvents = await mapWithConcurrency(
      sections,
      LLM_CONCURRENCY,
      (section) => extractEventFromChunk(llm, section),
      (completed, total) => {
        onProgress?.({
          stage: 'extracting',
          chunkIndex: completed,
          totalChunks: total,
          message: `抽取事件: ${completed}/${total}`,
        });
      },
    );

    // 6. Embed event title + content, store events.
    onProgress?.({
      stage: 'embedding-events',
      chunkIndex: 0,
      totalChunks: sections.length,
      message: `嵌入 events: 0/${sections.length}`,
    });
    const titleTexts = extractedEvents.map((e) => e.title);
    const contentTexts = extractedEvents.map((e) => `${e.title}\n\n${e.content}`);
    const [titleEmbeddings, contentEmbeddings] = await Promise.all([
      engine.embedBatch(titleTexts),
      engine.embedBatch(contentTexts),
    ]);
    if (titleEmbeddings === null || contentEmbeddings === null) {
      onProgress?.({ stage: 'error', message: 'event embedding failed' });
      throw new Error('event embedding failed');
    }

    const events: KnowledgeEvent[] = [];
    for (let i = 0; i < extractedEvents.length; i++) {
      const extracted = extractedEvents[i]!;
      const chunk = chunks[i]!;
      const event = await store.insertEvent({
        sourceId: source.id,
        documentId: document.id,
        chunkId: chunk.id,
        rank: i,
        title: extracted.title,
        summary: extracted.summary.length > 0 ? extracted.summary : null,
        content: extracted.content,
        category: extracted.category.length > 0 ? extracted.category : null,
        keywords: extracted.keywords,
        titleEmbedding: titleEmbeddings[i] ?? null,
        contentEmbedding: contentEmbeddings[i] ?? null,
      });
      events.push(event);
      onProgress?.({
        stage: 'embedding-events',
        chunkIndex: i + 1,
        totalChunks: sections.length,
        message: `嵌入 events: ${i + 1}/${sections.length}`,
      });
    }

    // 7. Upsert entities + embed entity names.
    onProgress?.({ stage: 'embedding-entities', message: '嵌入 entities...' });
    const entityMap = new Map<string, { type: string; name: string; description: string }>();
    for (const extracted of extractedEvents) {
      for (const entity of extracted.entities) {
        const key = `${entity.type}|${entity.name.toLowerCase()}`;
        if (!entityMap.has(key)) {
          entityMap.set(key, entity);
        }
      }
    }
    const uniqueEntities = Array.from(entityMap.values());
    const entityEmbeddings =
      uniqueEntities.length > 0
        ? await engine.embedBatch(uniqueEntities.map((e) => e.name))
        : [];
    if (uniqueEntities.length > 0 && entityEmbeddings === null) {
      onProgress?.({ stage: 'error', message: 'entity embedding failed' });
      throw new Error('entity embedding failed');
    }

    const entityIdByEntityKey = new Map<string, string>();
    for (let i = 0; i < uniqueEntities.length; i++) {
      const entity = uniqueEntities[i]!;
      const embedding = entityEmbeddings?.[i] ?? null;
      const stored = await store.upsertEntity({
        sourceId: source.id,
        type: entity.type,
        name: entity.name,
        description: entity.description.length > 0 ? entity.description : null,
        embedding,
      });
      entityIdByEntityKey.set(`${entity.type}|${entity.name.toLowerCase()}`, stored.id);
    }

    // 8. Embed relation per (event, entity) pair and store edges.
    onProgress?.({ stage: 'embedding-relations', message: '嵌入关系...' });
    const relationPairs: Array<{ eventIndex: number; entity: { type: string; name: string; description: string } }> = [];
    for (let i = 0; i < extractedEvents.length; i++) {
      const extracted = extractedEvents[i]!;
      for (const entity of extracted.entities) {
        relationPairs.push({ eventIndex: i, entity });
      }
    }
    const relationTexts = relationPairs.map(({ eventIndex, entity }) => {
      const event = events[eventIndex]!;
      return entity.description.length > 0
        ? entity.description
        : `${event.title} ${entity.name}`;
    });
    const relationEmbeddings =
      relationPairs.length > 0 ? await engine.embedBatch(relationTexts) : [];
    if (relationPairs.length > 0 && relationEmbeddings === null) {
      onProgress?.({ stage: 'error', message: 'relation embedding failed' });
      throw new Error('relation embedding failed');
    }

    for (let i = 0; i < relationPairs.length; i++) {
      const pair = relationPairs[i]!;
      const event = events[pair.eventIndex]!;
      const entityKey = `${pair.entity.type}|${pair.entity.name.toLowerCase()}`;
      const entityId = entityIdByEntityKey.get(entityKey);
      if (entityId === undefined) continue;
      const embedding = relationEmbeddings?.[i] ?? null;
      await store.insertEventEntity({
        eventId: event.id,
        entityId,
        weight: 1.0,
        description: pair.entity.description.length > 0 ? pair.entity.description : null,
        embedding,
      });
    }

    // 9. Update document status.
    await store.updateDocumentStatus(document.id, 'completed', chunks.length);
    store.commitTransaction();

    onProgress?.({
      stage: 'completed',
      message: `摄入完成：${chunks.length} chunks, ${events.length} events, ${uniqueEntities.length} entities`,
    });

    return {
      documentId: document.id,
      chunkCount: chunks.length,
      eventCount: events.length,
      entityCount: uniqueEntities.length,
    };
  } catch (error) {
    store.rollbackTransaction();
    throw error;
  }
}

/** Ingest content from a string (rather than a file path). Used for tests. */
export async function ingestContent(
  store: KnowledgeStore,
  llm: LlmCaller,
  params: { name: string; content: string },
  onProgress?: IngestProgressCallback,
): Promise<{ documentId: string; chunkCount: number; eventCount: number; entityCount: number }> {
  const engine = store.getEmbeddingEngine();
  if (engine === undefined || !engine.available) {
    onProgress?.({ stage: 'error', message: 'embedding engine unavailable' });
    throw new Error('embedding engine unavailable — knowledge base requires fastembed');
  }

  const sections = chunkMarkdown(params.content);
  if (sections.length === 0) {
    onProgress?.({ stage: 'error', message: '内容无有效切片' });
    throw new Error('content has no sections to ingest');
  }

  store.beginTransaction();
  try {
    const source = await store.createSource({
      name: params.name,
      filePath: null,
      description: null,
    });
    const document = await store.createDocument({
      sourceId: source.id,
      title: params.name,
      content: params.content,
    });

    onProgress?.({ stage: 'embedding-chunks', chunkIndex: 0, totalChunks: sections.length, message: `嵌入 chunks: 0/${sections.length}` });
    const chunkEmbeddings = await engine.embedBatch(
      sections.map((s) => (s.heading !== null ? `${s.heading}\n${s.content}` : s.content)),
    );
    if (chunkEmbeddings === null) {
      onProgress?.({ stage: 'error', message: 'chunk embedding failed' });
      throw new Error('chunk embedding failed');
    }
    const chunks = [];
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]!;
      const chunk = await store.insertChunk({
        sourceId: source.id,
        documentId: document.id,
        rank: section.rank,
        heading: section.heading,
        content: section.content,
        rawContent: section.rawContent,
        embedding: chunkEmbeddings[i] ?? null,
      });
      chunks.push(chunk);
      onProgress?.({ stage: 'embedding-chunks', chunkIndex: i + 1, totalChunks: sections.length, message: `嵌入 chunks: ${i + 1}/${sections.length}` });
    }

    onProgress?.({ stage: 'extracting', chunkIndex: 0, totalChunks: sections.length, message: `抽取事件: 0/${sections.length}` });
    const extractedEvents = await mapWithConcurrency(
      sections,
      LLM_CONCURRENCY,
      (section) => extractEventFromChunk(llm, section),
      (completed, total) => {
        onProgress?.({ stage: 'extracting', chunkIndex: completed, totalChunks: total, message: `抽取事件: ${completed}/${total}` });
      },
    );

    onProgress?.({ stage: 'embedding-events', chunkIndex: 0, totalChunks: sections.length, message: `嵌入 events: 0/${sections.length}` });
    const [titleEmbeddings, contentEmbeddings] = await Promise.all([
      engine.embedBatch(extractedEvents.map((e) => e.title)),
      engine.embedBatch(extractedEvents.map((e) => `${e.title}\n\n${e.content}`)),
    ]);
    if (titleEmbeddings === null || contentEmbeddings === null) {
      onProgress?.({ stage: 'error', message: 'event embedding failed' });
      throw new Error('event embedding failed');
    }
    const events: KnowledgeEvent[] = [];
    for (let i = 0; i < extractedEvents.length; i++) {
      const extracted = extractedEvents[i]!;
      const chunk = chunks[i]!;
      const event = await store.insertEvent({
        sourceId: source.id,
        documentId: document.id,
        chunkId: chunk.id,
        rank: i,
        title: extracted.title,
        summary: extracted.summary.length > 0 ? extracted.summary : null,
        content: extracted.content,
        category: extracted.category.length > 0 ? extracted.category : null,
        keywords: extracted.keywords,
        titleEmbedding: titleEmbeddings[i] ?? null,
        contentEmbedding: contentEmbeddings[i] ?? null,
      });
      events.push(event);
      onProgress?.({ stage: 'embedding-events', chunkIndex: i + 1, totalChunks: sections.length, message: `嵌入 events: ${i + 1}/${sections.length}` });
    }

    onProgress?.({ stage: 'embedding-entities', message: '嵌入 entities...' });
    const entityMap = new Map<string, { type: string; name: string; description: string }>();
    for (const extracted of extractedEvents) {
      for (const entity of extracted.entities) {
        const key = `${entity.type}|${entity.name.toLowerCase()}`;
        if (!entityMap.has(key)) entityMap.set(key, entity);
      }
    }
    const uniqueEntities = Array.from(entityMap.values());
    const entityEmbeddings = uniqueEntities.length > 0 ? await engine.embedBatch(uniqueEntities.map((e) => e.name)) : [];
    if (uniqueEntities.length > 0 && entityEmbeddings === null) {
      onProgress?.({ stage: 'error', message: 'entity embedding failed' });
      throw new Error('entity embedding failed');
    }
    const entityIdByEntityKey = new Map<string, string>();
    for (let i = 0; i < uniqueEntities.length; i++) {
      const entity = uniqueEntities[i]!;
      const stored = await store.upsertEntity({
        sourceId: source.id,
        type: entity.type,
        name: entity.name,
        description: entity.description.length > 0 ? entity.description : null,
        embedding: entityEmbeddings?.[i] ?? null,
      });
      entityIdByEntityKey.set(`${entity.type}|${entity.name.toLowerCase()}`, stored.id);
    }

    onProgress?.({ stage: 'embedding-relations', message: '嵌入关系...' });
    const relationPairs: Array<{ eventIndex: number; entity: { type: string; name: string; description: string } }> = [];
    for (let i = 0; i < extractedEvents.length; i++) {
      for (const entity of extractedEvents[i]!.entities) {
        relationPairs.push({ eventIndex: i, entity });
      }
    }
    const relationTexts = relationPairs.map(({ eventIndex, entity }) => {
      const event = events[eventIndex]!;
      return entity.description.length > 0 ? entity.description : `${event.title} ${entity.name}`;
    });
    const relationEmbeddings = relationPairs.length > 0 ? await engine.embedBatch(relationTexts) : [];
    if (relationPairs.length > 0 && relationEmbeddings === null) {
      onProgress?.({ stage: 'error', message: 'relation embedding failed' });
      throw new Error('relation embedding failed');
    }
    for (let i = 0; i < relationPairs.length; i++) {
      const pair = relationPairs[i]!;
      const event = events[pair.eventIndex]!;
      const entityKey = `${pair.entity.type}|${pair.entity.name.toLowerCase()}`;
      const entityId = entityIdByEntityKey.get(entityKey);
      if (entityId === undefined) continue;
      await store.insertEventEntity({
        eventId: event.id,
        entityId,
        weight: 1.0,
        description: pair.entity.description.length > 0 ? pair.entity.description : null,
        embedding: relationEmbeddings?.[i] ?? null,
      });
    }

    await store.updateDocumentStatus(document.id, 'completed', chunks.length);
    store.commitTransaction();

    onProgress?.({ stage: 'completed', message: `摄入完成：${chunks.length} chunks, ${events.length} events, ${uniqueEntities.length} entities` });

    return {
      documentId: document.id,
      chunkCount: chunks.length,
      eventCount: events.length,
      entityCount: uniqueEntities.length,
    };
  } catch (error) {
    store.rollbackTransaction();
    throw error;
  }
}

async function collectSupportedFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSupportedFiles(fullPath)));
    } else if (entry.isFile() && isSupportedFile(fullPath)) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

export async function ingestDirectory(
  store: KnowledgeStore,
  llm: LlmCaller,
  dirPath: string,
  onProgress?: IngestProgressCallback,
): Promise<{
  succeeded: number;
  failed: number;
  totalChunks: number;
  totalEvents: number;
  totalEntities: number;
  errors: Array<{ filePath: string; message: string }>;
}> {
  const files = await collectSupportedFiles(dirPath);
  if (files.length === 0) {
    throw new Error(`no supported files (.md, .markdown, .txt) found in ${dirPath}`);
  }

  const errors: Array<{ filePath: string; message: string }> = [];
  let succeeded = 0;
  let totalChunks = 0;
  let totalEvents = 0;
  let totalEntities = 0;

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]!;
    const fileProgress = (progress: IngestProgress): void => {
      const prefix = `批量摄入 ${i + 1}/${files.length}: ${basename(filePath)}`;
      onProgress?.({ ...progress, message: `${prefix} · ${progress.message}` });
    };

    try {
      const result = await ingestFile(store, llm, filePath, fileProgress);
      succeeded += 1;
      totalChunks += result.chunkCount;
      totalEvents += result.eventCount;
      totalEntities += result.entityCount;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ filePath, message });
      onProgress?.({
        stage: 'error',
        message: `批量摄入 ${i + 1}/${files.length}: ${basename(filePath)} · 失败: ${message}`,
      });
    }
  }

  onProgress?.({
    stage: 'completed',
    message: `批量摄入完成：${succeeded}/${files.length} 个文件成功，${totalChunks} chunks, ${totalEvents} events, ${totalEntities} entities`,
  });

  return {
    succeeded,
    failed: errors.length,
    totalChunks,
    totalEvents,
    totalEntities,
    errors,
  };
}

/** Re-export chunking functions for convenience. */
export { chunkMarkdown, chunkText };
export type { ChunkSection };
