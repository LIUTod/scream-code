import { mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'pathe';

import type { EmbeddingEngine } from '@scream-code/memory';

import type {
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeEntity,
  KnowledgeEvent,
  KnowledgeEventEntity,
  KnowledgeSearchResult,
  KnowledgeSource,
} from './types.js';

const ENTITY_TYPES = new Set([
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
]);

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${ts}-${rand}`;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replaceAll(/\s+/g, ' ');
}

function vectorToJson(vec: Float32Array | null): string | null {
  if (vec === null) return null;
  return JSON.stringify(Array.from(vec));
}

function jsonToVector(json: string | null): Float32Array | null {
  if (json === null) return null;
  try {
    const arr = JSON.parse(json) as number[];
    return new Float32Array(arr);
  } catch {
    return null;
  }
}

function isEntityType(value: string): boolean {
  return ENTITY_TYPES.has(value);
}

export class KnowledgeStore {
  private readonly dbPath: string;
  private db: DatabaseSync | undefined;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private embeddingEngine: EmbeddingEngine | undefined;

  constructor(projectDir: string) {
    this.dbPath = join(projectDir, 'knowledge', 'knowledge.db');
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit();
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.createSchema();
    this.initialized = true;
  }

  close(): void {
    if (this.db !== undefined) {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      this.db.close();
      this.db = undefined;
    }
    this.initialized = false;
    this.initPromise = null;
  }

  setEmbeddingEngine(engine: EmbeddingEngine): void {
    this.embeddingEngine = engine;
  }

  getEmbeddingEngine(): EmbeddingEngine | undefined {
    return this.embeddingEngine;
  }

  /**
   * Proactively load the embedding model (downloads on first call).
   * Call before ingestion so the user gets a clear download prompt instead
   * of a mid-ingest failure.
   */
  async ensureEmbeddingReady(): Promise<{ ok: boolean; reason?: string }> {
    if (this.embeddingEngine === undefined) return { ok: false, reason: 'engine not set' };
    const ok = await this.embeddingEngine.ensureReady();
    return { ok, reason: ok ? undefined : 'fastembed init failed' };
  }

  /**
   * Begin a write transaction. Use commitTransaction / rollbackTransaction
   * to close it. Used by ingest to keep chunks/events/entities/edges atomic —
   * a mid-ingest failure leaves no partial rows.
   */
  beginTransaction(): void {
    if (this.db === undefined) {
      throw new Error('knowledge store not initialized');
    }
    this.db.exec('BEGIN');
  }

  commitTransaction(): void {
    if (this.db === undefined) {
      throw new Error('knowledge store not initialized');
    }
    this.db.exec('COMMIT');
  }

  rollbackTransaction(): void {
    if (this.db === undefined) return;
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // Ignore rollback failures — the original error is more useful.
    }
  }

  private createSchema(): void {
    if (this.db === undefined) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        file_path TEXT,
        description TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        chunk_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_documents_source ON knowledge_documents(source_id);

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        rank INTEGER NOT NULL,
        heading TEXT,
        content TEXT NOT NULL,
        raw_content TEXT,
        embedding_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(document_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source ON knowledge_chunks(source_id);

      CREATE TABLE IF NOT EXISTS knowledge_events (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
        rank INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        content TEXT NOT NULL,
        category TEXT,
        keywords TEXT,
        title_embedding_json TEXT,
        content_embedding_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_events_chunk ON knowledge_events(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_events_doc ON knowledge_events(document_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_events_source ON knowledge_events(source_id);

      CREATE TABLE IF NOT EXISTS knowledge_entities (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        description TEXT,
        embedding_json TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(source_id, type, normalized_name)
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_entities_source ON knowledge_entities(source_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_entities_name ON knowledge_entities(normalized_name);

      CREATE TABLE IF NOT EXISTS knowledge_event_entities (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES knowledge_events(id) ON DELETE CASCADE,
        entity_id TEXT NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
        weight REAL DEFAULT 1.0,
        description TEXT,
        embedding_json TEXT,
        UNIQUE(event_id, entity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_event_entities_event ON knowledge_event_entities(event_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_event_entities_entity ON knowledge_event_entities(entity_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
        heading, content, content='knowledge_chunks', content_rowid='rowid'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_events_fts USING fts5(
        title, summary, content, content='knowledge_events', content_rowid='rowid'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_entities_fts USING fts5(
        name, description, content='knowledge_entities', content_rowid='rowid'
      );
    `);
  }

  // ── Sources ────────────────────────────────────────────────────────

  async createSource(params: {
    name: string;
    filePath?: string | null;
    description?: string | null;
  }): Promise<KnowledgeSource> {
    await this.init();
    if (this.db === undefined) throw new Error('knowledge store not initialized');
    const id = generateId('src');
    const createdAt = Date.now();
    this.db
      .prepare(
        'INSERT INTO knowledge_sources (id, name, file_path, description, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, params.name, params.filePath ?? null, params.description ?? null, createdAt);
    return {
      id,
      name: params.name,
      filePath: params.filePath ?? null,
      description: params.description ?? null,
      createdAt,
    };
  }

  async findSourceByFilePath(filePath: string): Promise<KnowledgeSource | undefined> {
    await this.init();
    if (this.db === undefined) return undefined;
    const row = this.db
      .prepare('SELECT * FROM knowledge_sources WHERE file_path = ?')
      .get(filePath) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToSource(row);
  }

  async listSources(): Promise<KnowledgeSource[]> {
    await this.init();
    if (this.db === undefined) return [];
    const rows = this.db
      .prepare('SELECT * FROM knowledge_sources ORDER BY created_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToSource);
  }

  async getSource(id: string): Promise<KnowledgeSource | undefined> {
    await this.init();
    if (this.db === undefined) return undefined;
    const row = this.db
      .prepare('SELECT * FROM knowledge_sources WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToSource(row);
  }

  async deleteSource(id: string): Promise<boolean> {
    await this.init();
    if (this.db === undefined) return false;
    const result = this.db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ── Documents ──────────────────────────────────────────────────────

  async createDocument(params: {
    sourceId: string;
    title: string;
    content?: string | null;
  }): Promise<KnowledgeDocument> {
    if (this.db === undefined) throw new Error('knowledge store not initialized');
    const id = generateId('doc');
    const createdAt = Date.now();
    this.db
      .prepare(
        'INSERT INTO knowledge_documents (id, source_id, title, content, status, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, params.sourceId, params.title, params.content ?? null, 'pending', 0, createdAt);
    return {
      id,
      sourceId: params.sourceId,
      title: params.title,
      content: params.content ?? null,
      status: 'pending',
      chunkCount: 0,
      createdAt,
    };
  }

  async updateDocumentStatus(
    documentId: string,
    status: KnowledgeDocument['status'],
    chunkCount?: number,
  ): Promise<void> {
    if (this.db === undefined) return;
    if (chunkCount !== undefined) {
      this.db
        .prepare('UPDATE knowledge_documents SET status = ?, chunk_count = ? WHERE id = ?')
        .run(status, chunkCount, documentId);
    } else {
      this.db
        .prepare('UPDATE knowledge_documents SET status = ? WHERE id = ?')
        .run(status, documentId);
    }
  }

  async listDocuments(): Promise<Array<KnowledgeDocument & { sourceName: string }>> {
    await this.init();
    if (this.db === undefined) return [];
    const rows = this.db
      .prepare(
        `SELECT d.*, s.name AS source_name
         FROM knowledge_documents d
         JOIN knowledge_sources s ON s.id = d.source_id
         ORDER BY d.created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...rowToDocument(row),
      sourceName: String(row['source_name']),
    }));
  }

  async getDocument(id: string): Promise<KnowledgeDocument | undefined> {
    await this.init();
    if (this.db === undefined) return undefined;
    const row = this.db
      .prepare('SELECT * FROM knowledge_documents WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToDocument(row);
  }

  // ── Chunks ─────────────────────────────────────────────────────────

  async insertChunk(params: {
    sourceId: string;
    documentId: string;
    rank: number;
    heading: string | null;
    content: string;
    rawContent: string | null;
    embedding: Float32Array | null;
  }): Promise<KnowledgeChunk> {
    if (this.db === undefined) throw new Error('knowledge store not initialized');
    const id = generateId('chk');
    const createdAt = Date.now();
    const embeddingJson = vectorToJson(params.embedding);
    this.db
      .prepare(
        `INSERT INTO knowledge_chunks
         (id, source_id, document_id, rank, heading, content, raw_content, embedding_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.sourceId,
        params.documentId,
        params.rank,
        params.heading,
        params.content,
        params.rawContent,
        embeddingJson,
        createdAt,
      );
    // FTS5 external-content table — insert into it manually.
    this.db
      .prepare(
        `INSERT INTO knowledge_chunks_fts (rowid, heading, content)
         VALUES ((SELECT rowid FROM knowledge_chunks WHERE id = ?), ?, ?)`,
      )
      .run(id, params.heading ?? '', params.content);
    return {
      id,
      sourceId: params.sourceId,
      documentId: params.documentId,
      rank: params.rank,
      heading: params.heading,
      content: params.content,
      rawContent: params.rawContent,
      embedding: params.embedding,
      createdAt,
    };
  }

  async getChunk(id: string): Promise<KnowledgeChunk | undefined> {
    await this.init();
    if (this.db === undefined) return undefined;
    const row = this.db
      .prepare('SELECT * FROM knowledge_chunks WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToChunk(row);
  }

  async listChunksByDocument(documentId: string): Promise<KnowledgeChunk[]> {
    await this.init();
    if (this.db === undefined) return [];
    const rows = this.db
      .prepare('SELECT * FROM knowledge_chunks WHERE document_id = ? ORDER BY rank ASC')
      .all(documentId) as Array<Record<string, unknown>>;
    return rows.map(rowToChunk);
  }

  /** Load all chunk embeddings + ids for vector search. */
  async loadAllChunkEmbeddings(): Promise<Array<{ id: string; embedding: Float32Array }>> {
    await this.init();
    if (this.db === undefined) return [];
    const rows = this.db
      .prepare('SELECT id, embedding_json FROM knowledge_chunks WHERE embedding_json IS NOT NULL')
      .all() as Array<{ id: string; embedding_json: string }>;
    const out: Array<{ id: string; embedding: Float32Array }> = [];
    for (const row of rows) {
      const vec = jsonToVector(row.embedding_json);
      if (vec !== null) out.push({ id: row.id, embedding: vec });
    }
    return out;
  }

  // ── Events ─────────────────────────────────────────────────────────

  async insertEvent(params: {
    sourceId: string;
    documentId: string;
    chunkId: string;
    rank: number;
    title: string;
    summary: string | null;
    content: string;
    category: string | null;
    keywords: string[];
    titleEmbedding: Float32Array | null;
    contentEmbedding: Float32Array | null;
  }): Promise<KnowledgeEvent> {
    if (this.db === undefined) throw new Error('knowledge store not initialized');
    const id = generateId('evt');
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO knowledge_events
         (id, source_id, document_id, chunk_id, rank, title, summary, content, category, keywords,
          title_embedding_json, content_embedding_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.sourceId,
        params.documentId,
        params.chunkId,
        params.rank,
        params.title,
        params.summary,
        params.content,
        params.category,
        JSON.stringify(params.keywords),
        vectorToJson(params.titleEmbedding),
        vectorToJson(params.contentEmbedding),
        createdAt,
      );
    this.db
      .prepare(
        `INSERT INTO knowledge_events_fts (rowid, title, summary, content)
         VALUES ((SELECT rowid FROM knowledge_events WHERE id = ?), ?, ?, ?)`,
      )
      .run(id, params.title, params.summary ?? '', params.content);
    return {
      id,
      sourceId: params.sourceId,
      documentId: params.documentId,
      chunkId: params.chunkId,
      rank: params.rank,
      title: params.title,
      summary: params.summary,
      content: params.content,
      category: params.category,
      keywords: params.keywords,
      titleEmbedding: params.titleEmbedding,
      contentEmbedding: params.contentEmbedding,
      createdAt,
    };
  }

  async getEvent(id: string): Promise<KnowledgeEvent | undefined> {
    await this.init();
    if (this.db === undefined) return undefined;
    const row = this.db
      .prepare('SELECT * FROM knowledge_events WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToEvent(row);
  }

  async listEventsByDocument(documentId: string): Promise<KnowledgeEvent[]> {
    await this.init();
    if (this.db === undefined) return [];
    const rows = this.db
      .prepare('SELECT * FROM knowledge_events WHERE document_id = ? ORDER BY rank ASC')
      .all(documentId) as Array<Record<string, unknown>>;
    return rows.map(rowToEvent);
  }

  /** Find events by title vector similarity. */
  async findEventsByTitleVector(
    queryVec: Float32Array,
    options: { limit?: number; threshold?: number } = {},
  ): Promise<Array<{ event: KnowledgeEvent; score: number }>> {
    await this.init();
    if (this.db === undefined) return [];
    const limit = options.limit ?? 20;
    const threshold = options.threshold ?? 0;
    const rows = this.db
      .prepare(
        'SELECT id, title_embedding_json FROM knowledge_events WHERE title_embedding_json IS NOT NULL',
      )
      .all() as Array<{ id: string; title_embedding_json: string }>;
    const scored: Array<{ id: string; score: number }> = [];
    for (const row of rows) {
      const vec = jsonToVector(row.title_embedding_json);
      if (vec === null) continue;
      const score = this.embeddingEngine?.cosineSimilarity(queryVec, vec) ?? 0;
      if (score >= threshold) scored.push({ id: row.id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    const out: Array<{ event: KnowledgeEvent; score: number }> = [];
    for (const item of top) {
      const event = await this.getEvent(item.id);
      if (event !== undefined) out.push({ event, score: item.score });
    }
    return out;
  }

  // ── Entities ───────────────────────────────────────────────────────

  async upsertEntity(params: {
    sourceId: string;
    type: string;
    name: string;
    description: string | null;
    embedding: Float32Array | null;
  }): Promise<KnowledgeEntity> {
    if (this.db === undefined) throw new Error('knowledge store not initialized');
    if (!isEntityType(params.type)) {
      throw new Error(`invalid entity type: ${params.type}`);
    }
    const normalizedName = normalizeName(params.name);
    const existing = this.db
      .prepare(
        'SELECT * FROM knowledge_entities WHERE source_id = ? AND type = ? AND normalized_name = ?',
      )
      .get(params.sourceId, params.type, normalizedName) as Record<string, unknown> | undefined;

    if (existing !== undefined) {
      // Update description if new one is provided and existing is null.
      if (params.description !== null && existing['description'] === null) {
        this.db
          .prepare('UPDATE knowledge_entities SET description = ? WHERE id = ?')
          .run(params.description, String(existing['id']));
      }
      if (params.embedding !== null && existing['embedding_json'] === null) {
        this.db
          .prepare('UPDATE knowledge_entities SET embedding_json = ? WHERE id = ?')
          .run(vectorToJson(params.embedding), String(existing['id']));
      }
      return rowToEntity(existing);
    }

    const id = generateId('ent');
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO knowledge_entities
         (id, source_id, type, name, normalized_name, description, embedding_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.sourceId,
        params.type,
        params.name,
        normalizedName,
        params.description,
        vectorToJson(params.embedding),
        createdAt,
      );
    this.db
      .prepare(
        `INSERT INTO knowledge_entities_fts (rowid, name, description)
         VALUES ((SELECT rowid FROM knowledge_entities WHERE id = ?), ?, ?)`,
      )
      .run(id, params.name, params.description ?? '');
    return {
      id,
      sourceId: params.sourceId,
      type: params.type as KnowledgeEntity['type'],
      name: params.name,
      normalizedName,
      description: params.description,
      embedding: params.embedding,
      createdAt,
    };
  }

  async findEntitiesByName(name: string, sourceId?: string): Promise<KnowledgeEntity[]> {
    await this.init();
    if (this.db === undefined) return [];
    const normalized = normalizeName(name);
    const rows =
      sourceId === undefined
        ? (this.db
            .prepare('SELECT * FROM knowledge_entities WHERE normalized_name = ?')
            .all(normalized) as Array<Record<string, unknown>>)
        : (this.db
            .prepare(
              'SELECT * FROM knowledge_entities WHERE normalized_name = ? AND source_id = ?',
            )
            .all(normalized, sourceId) as Array<Record<string, unknown>>);
    return rows.map(rowToEntity);
  }

  /** Find entities by name vector similarity. */
  async findEntitiesByVector(
    queryVec: Float32Array,
    options: { limit?: number; threshold?: number } = {},
  ): Promise<Array<{ entity: KnowledgeEntity; score: number }>> {
    await this.init();
    if (this.db === undefined) return [];
    const limit = options.limit ?? 20;
    const threshold = options.threshold ?? 0;
    const rows = this.db
      .prepare('SELECT id, embedding_json FROM knowledge_entities WHERE embedding_json IS NOT NULL')
      .all() as Array<{ id: string; embedding_json: string }>;
    const scored: Array<{ id: string; score: number }> = [];
    for (const row of rows) {
      const vec = jsonToVector(row.embedding_json);
      if (vec === null) continue;
      const score = this.embeddingEngine?.cosineSimilarity(queryVec, vec) ?? 0;
      if (score >= threshold) scored.push({ id: row.id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    const out: Array<{ entity: KnowledgeEntity; score: number }> = [];
    for (const item of top) {
      const row = this.db
        .prepare('SELECT * FROM knowledge_entities WHERE id = ?')
        .get(item.id) as Record<string, unknown> | undefined;
      if (row !== undefined) out.push({ entity: rowToEntity(row), score: item.score });
    }
    return out;
  }

  // ── Event-Entity edges ─────────────────────────────────────────────

  async insertEventEntity(params: {
    eventId: string;
    entityId: string;
    weight?: number;
    description: string | null;
    embedding: Float32Array | null;
  }): Promise<KnowledgeEventEntity> {
    if (this.db === undefined) throw new Error('knowledge store not initialized');
    const id = generateId('ee');
    this.db
      .prepare(
        `INSERT OR IGNORE INTO knowledge_event_entities
         (id, event_id, entity_id, weight, description, embedding_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.eventId,
        params.entityId,
        params.weight ?? 1.0,
        params.description,
        vectorToJson(params.embedding),
      );
    return {
      id,
      eventId: params.eventId,
      entityId: params.entityId,
      weight: params.weight ?? 1.0,
      description: params.description,
      embedding: params.embedding,
    };
  }

  async findEventsByEntity(entityId: string): Promise<KnowledgeEvent[]> {
    await this.init();
    if (this.db === undefined) return [];
    const rows = this.db
      .prepare(
        `SELECT e.* FROM knowledge_events e
         JOIN knowledge_event_entities ee ON ee.event_id = e.id
         WHERE ee.entity_id = ?`,
      )
      .all(entityId) as Array<Record<string, unknown>>;
    return rows.map(rowToEvent);
  }

  async findEntitiesByEvent(eventId: string): Promise<KnowledgeEntity[]> {
    await this.init();
    if (this.db === undefined) return [];
    const rows = this.db
      .prepare(
        `SELECT en.* FROM knowledge_entities en
         JOIN knowledge_event_entities ee ON ee.entity_id = en.id
         WHERE ee.event_id = ?`,
      )
      .all(eventId) as Array<Record<string, unknown>>;
    return rows.map(rowToEntity);
  }

  // ── Graph export ──────────────────────────────────────────────────

  async listEntities(sourceId?: string): Promise<Array<KnowledgeEntity & { eventCount: number }>> {
    await this.init();
    if (this.db === undefined) return [];
    const sql = sourceId
      ? `SELECT e.*, COUNT(ee.id) AS event_count
         FROM knowledge_entities e
         LEFT JOIN knowledge_event_entities ee ON ee.entity_id = e.id
         WHERE e.source_id = ?
         GROUP BY e.id
         ORDER BY event_count DESC`
      : `SELECT e.*, COUNT(ee.id) AS event_count
         FROM knowledge_entities e
         LEFT JOIN knowledge_event_entities ee ON ee.entity_id = e.id
         GROUP BY e.id
         ORDER BY event_count DESC`;
    const rows = sourceId
      ? (this.db.prepare(sql).all(sourceId) as Array<Record<string, unknown>>)
      : (this.db.prepare(sql).all() as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      ...rowToEntity(row),
      eventCount: Number(row['event_count'] ?? 0),
    }));
  }

  async listEvents(sourceId?: string): Promise<KnowledgeEvent[]> {
    await this.init();
    if (this.db === undefined) return [];
    const sql = sourceId
      ? 'SELECT * FROM knowledge_events WHERE source_id = ? ORDER BY rank ASC'
      : 'SELECT * FROM knowledge_events ORDER BY created_at DESC';
    const rows = sourceId
      ? (this.db.prepare(sql).all(sourceId) as Array<Record<string, unknown>>)
      : (this.db.prepare(sql).all() as Array<Record<string, unknown>>);
    return rows.map(rowToEvent);
  }

  async listEventEntities(sourceId?: string): Promise<Array<{ eventId: string; entityId: string }>> {
    await this.init();
    if (this.db === undefined) return [];
    const sql = sourceId
      ? `SELECT ee.event_id, ee.entity_id
         FROM knowledge_event_entities ee
         JOIN knowledge_events e ON e.id = ee.event_id
         WHERE e.source_id = ?`
      : 'SELECT event_id, entity_id FROM knowledge_event_entities';
    const rows = sourceId
      ? (this.db.prepare(sql).all(sourceId) as Array<Record<string, unknown>>)
      : (this.db.prepare(sql).all() as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      eventId: asString(row['event_id']),
      entityId: asString(row['entity_id']),
    }));
  }

  // ── FTS5 search ────────────────────────────────────────────────────

  async ftsSearchChunks(query: string, limit: number = 50): Promise<KnowledgeChunk[]> {
    await this.init();
    if (this.db === undefined) return [];
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery === undefined) return [];
    const rows = this.db
      .prepare(
        `SELECT c.* FROM knowledge_chunks c
         JOIN knowledge_chunks_fts f ON c.rowid = f.rowid
         WHERE f.knowledge_chunks_fts MATCH ?
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToChunk);
  }

  // ── Vector search ──────────────────────────────────────────────────

  async searchChunksByVector(
    queryVec: Float32Array,
    options: { limit?: number; threshold?: number } = {},
  ): Promise<Array<{ chunk: KnowledgeChunk; score: number }>> {
    await this.init();
    if (this.db === undefined) return [];
    const limit = options.limit ?? 50;
    const threshold = options.threshold ?? 0;
    const rows = this.db
      .prepare('SELECT id, embedding_json FROM knowledge_chunks WHERE embedding_json IS NOT NULL')
      .all() as Array<{ id: string; embedding_json: string }>;
    const scored: Array<{ id: string; score: number }> = [];
    for (const row of rows) {
      const vec = jsonToVector(row.embedding_json);
      if (vec === null) continue;
      const score = this.embeddingEngine?.cosineSimilarity(queryVec, vec) ?? 0;
      if (score >= threshold) scored.push({ id: row.id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    const out: Array<{ chunk: KnowledgeChunk; score: number }> = [];
    for (const item of top) {
      const chunk = await this.getChunk(item.id);
      if (chunk !== undefined) out.push({ chunk, score: item.score });
    }
    return out;
  }

  // ── Stats ──────────────────────────────────────────────────────────

  async stats(): Promise<{
    sources: number;
    documents: number;
    chunks: number;
    events: number;
    entities: number;
  }> {
    await this.init();
    if (this.db === undefined) {
      return { sources: 0, documents: 0, chunks: 0, events: 0, entities: 0 };
    }
    const count = (table: string): number => {
      const row = this.db!.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as
        | { c: number }
        | undefined;
      return row?.c ?? 0;
    };
    return {
      sources: count('knowledge_sources'),
      documents: count('knowledge_documents'),
      chunks: count('knowledge_chunks'),
      events: count('knowledge_events'),
      entities: count('knowledge_entities'),
    };
  }

  // ── Result builder ─────────────────────────────────────────────────

  async buildSearchResult(
    chunkId: string,
    score: number,
    eventId: string | null = null,
  ): Promise<KnowledgeSearchResult | undefined> {
    if (this.db === undefined) return undefined;
    const chunk = await this.getChunk(chunkId);
    if (chunk === undefined) return undefined;
    const docRow = this.db
      .prepare('SELECT * FROM knowledge_documents WHERE id = ?')
      .get(chunk.documentId) as Record<string, unknown> | undefined;
    if (docRow === undefined) return undefined;
    const sourceRow = this.db
      .prepare('SELECT * FROM knowledge_sources WHERE id = ?')
      .get(chunk.sourceId) as Record<string, unknown> | undefined;
    if (sourceRow === undefined) return undefined;
    let eventTitle: string | null = null;
    if (eventId !== null) {
      const event = await this.getEvent(eventId);
      eventTitle = event?.title ?? null;
    }
    return {
      chunkId: chunk.id,
      documentId: chunk.documentId,
      sourceId: chunk.sourceId,
      sourceName: String(sourceRow['name']),
      heading: chunk.heading,
      content: chunk.content,
      score,
      eventId,
      eventTitle,
    };
  }
}

// ── Row converters ─────────────────────────────────────────────────

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function rowToSource(row: Record<string, unknown>): KnowledgeSource {
  return {
    id: asString(row['id']),
    name: asString(row['name']),
    filePath: asNullableString(row['file_path']),
    description: asNullableString(row['description']),
    createdAt: Number(row['created_at']),
  };
}

function rowToDocument(row: Record<string, unknown>): KnowledgeDocument {
  return {
    id: asString(row['id']),
    sourceId: asString(row['source_id']),
    title: asString(row['title']),
    content: asNullableString(row['content']),
    status: asString(row['status']) as KnowledgeDocument['status'],
    chunkCount: Number(row['chunk_count'] ?? 0),
    createdAt: Number(row['created_at']),
  };
}

function rowToChunk(row: Record<string, unknown>): KnowledgeChunk {
  return {
    id: asString(row['id']),
    sourceId: asString(row['source_id']),
    documentId: asString(row['document_id']),
    rank: Number(row['rank']),
    heading: asNullableString(row['heading']),
    content: asString(row['content']),
    rawContent: asNullableString(row['raw_content']),
    embedding: jsonToVector(asNullableString(row['embedding_json'])),
    createdAt: Number(row['created_at']),
  };
}

function rowToEvent(row: Record<string, unknown>): KnowledgeEvent {
  let keywords: string[] = [];
  try {
    const parsed = JSON.parse(asString(row['keywords'] ?? '[]'));
    if (Array.isArray(parsed)) keywords = parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    // keep empty
  }
  return {
    id: asString(row['id']),
    sourceId: asString(row['source_id']),
    documentId: asString(row['document_id']),
    chunkId: asString(row['chunk_id']),
    rank: Number(row['rank']),
    title: asString(row['title']),
    summary: asNullableString(row['summary']),
    content: asString(row['content']),
    category: asNullableString(row['category']),
    keywords,
    titleEmbedding: jsonToVector(asNullableString(row['title_embedding_json'])),
    contentEmbedding: jsonToVector(asNullableString(row['content_embedding_json'])),
    createdAt: Number(row['created_at']),
  };
}

function rowToEntity(row: Record<string, unknown>): KnowledgeEntity {
  return {
    id: asString(row['id']),
    sourceId: asString(row['source_id']),
    type: asString(row['type']) as KnowledgeEntity['type'],
    name: asString(row['name']),
    normalizedName: asString(row['normalized_name']),
    description: asNullableString(row['description']),
    embedding: jsonToVector(asNullableString(row['embedding_json'])),
    createdAt: Number(row['created_at']),
  };
}

/**
 * Tokenize text so FTS5's unicode61 tokenizer can index mixed CJK/ASCII text.
 * Mirrors the memory package's `toFtsText`.
 */
function toFtsText(text: string): string {
  const lower = text.toLowerCase();
  const withBoundaries = lower
    .replaceAll(/([一-鿿㐀-䶿])([a-z0-9])/g, '$1 $2')
    .replaceAll(/([a-z0-9])([一-鿿㐀-䶿])/g, '$1 $2');
  const parts = withBoundaries.split(/[^a-z0-9一-鿿㐀-䶿]+/);
  const tokens: string[] = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    if (/^[a-z0-9]+$/.test(part)) {
      tokens.push(part);
    } else {
      for (const ch of part) {
        if (ch.length > 0) tokens.push(ch);
      }
    }
  }
  return tokens.join(' ');
}

function buildFtsQuery(search: string): string | undefined {
  const ftsText = toFtsText(search);
  const tokens = ftsText.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(' AND ');
}
