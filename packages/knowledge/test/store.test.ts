import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KnowledgeStore } from '../src/store.js';

describe('KnowledgeStore', () => {
  let tmpDir: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-knowledge-test-'));
    store = new KnowledgeStore(tmpDir);
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('sources', () => {
    it('creates and finds a source by file path', async () => {
      const source = await store.createSource({
        name: 'doc.md',
        filePath: '/tmp/doc.md',
        description: null,
      });
      const found = await store.findSourceByFilePath('/tmp/doc.md');
      expect(found).toBeDefined();
      expect(found!.id).toBe(source.id);
      expect(found!.name).toBe('doc.md');
    });

    it('lists sources in creation order (newest first)', async () => {
      const a = await store.createSource({ name: 'a' });
      await new Promise((r) => setTimeout(r, 5));
      const b = await store.createSource({ name: 'b' });
      const list = await store.listSources();
      expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
    });

    it('deletes a source and cascades', async () => {
      const source = await store.createSource({ name: 'doc.md' });
      const doc = await store.createDocument({
        sourceId: source.id,
        title: 'doc.md',
      });
      await store.insertChunk({
        sourceId: source.id,
        documentId: doc.id,
        rank: 0,
        heading: 'h',
        content: 'c',
        rawContent: 'c',
        embedding: null,
      });
      const ok = await store.deleteSource(source.id);
      expect(ok).toBe(true);
      const list = await store.listSources();
      expect(list).toHaveLength(0);
      const docs = await store.listDocuments();
      expect(docs).toHaveLength(0);
    });
  });

  describe('documents', () => {
    it('creates a document with pending status', async () => {
      const source = await store.createSource({ name: 'doc.md' });
      const doc = await store.createDocument({
        sourceId: source.id,
        title: 'doc.md',
        content: '# hi',
      });
      expect(doc.status).toBe('pending');
      expect(doc.chunkCount).toBe(0);
    });

    it('updates document status and chunk count', async () => {
      const source = await store.createSource({ name: 'doc.md' });
      const doc = await store.createDocument({
        sourceId: source.id,
        title: 'doc.md',
      });
      await store.updateDocumentStatus(doc.id, 'completed', 5);
      const found = await store.getDocument(doc.id);
      expect(found!.status).toBe('completed');
      expect(found!.chunkCount).toBe(5);
    });

    it('lists documents with source name', async () => {
      const source = await store.createSource({ name: 'doc.md' });
      const doc = await store.createDocument({
        sourceId: source.id,
        title: 'doc.md',
      });
      const list = await store.listDocuments();
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe(doc.id);
      expect(list[0]!.sourceName).toBe('doc.md');
    });
  });

  describe('chunks', () => {
    it('inserts and retrieves a chunk', async () => {
      const source = await store.createSource({ name: 'doc.md' });
      const doc = await store.createDocument({
        sourceId: source.id,
        title: 'doc.md',
      });
      const chunk = await store.insertChunk({
        sourceId: source.id,
        documentId: doc.id,
        rank: 0,
        heading: 'Intro',
        content: 'Hello world',
        rawContent: 'Hello world',
        embedding: new Float32Array([0.1, 0.2, 0.3]),
      });
      const found = await store.getChunk(chunk.id);
      expect(found).toBeDefined();
      expect(found!.heading).toBe('Intro');
      expect(found!.content).toBe('Hello world');
      expect(Array.from(found!.embedding!)).toEqual([
        expect.closeTo(0.1, 5),
        expect.closeTo(0.2, 5),
        expect.closeTo(0.3, 5),
      ]);
    });

    it('lists chunks by document in rank order', async () => {
      const source = await store.createSource({ name: 'doc.md' });
      const doc = await store.createDocument({
        sourceId: source.id,
        title: 'doc.md',
      });
      await store.insertChunk({
        sourceId: source.id,
        documentId: doc.id,
        rank: 2,
        heading: 'C',
        content: 'c',
        rawContent: 'c',
        embedding: null,
      });
      await store.insertChunk({
        sourceId: source.id,
        documentId: doc.id,
        rank: 0,
        heading: 'A',
        content: 'a',
        rawContent: 'a',
        embedding: null,
      });
      await store.insertChunk({
        sourceId: source.id,
        documentId: doc.id,
        rank: 1,
        heading: 'B',
        content: 'b',
        rawContent: 'b',
        embedding: null,
      });
      const chunks = await store.listChunksByDocument(doc.id);
      expect(chunks.map((c) => c.heading)).toEqual(['A', 'B', 'C']);
    });

    it('FTS5 search finds chunks by keyword', async () => {
      const source = await store.createSource({ name: 'doc.md' });
      const doc = await store.createDocument({
        sourceId: source.id,
        title: 'doc.md',
      });
      await store.insertChunk({
        sourceId: source.id,
        documentId: doc.id,
        rank: 0,
        heading: 'Rust',
        content: 'Rust is a systems programming language',
        rawContent: 'Rust',
        embedding: null,
      });
      await store.insertChunk({
        sourceId: source.id,
        documentId: doc.id,
        rank: 1,
        heading: 'Python',
        content: 'Python is a scripting language',
        rawContent: 'Python',
        embedding: null,
      });
      const found = await store.ftsSearchChunks('rust', 10);
      expect(found).toHaveLength(1);
      expect(found[0]!.heading).toBe('Rust');
    });
  });

  describe('events', () => {
    it('inserts and retrieves an event', async () => {
      const source = await store.createSource({ name: 'doc.md' });
      const doc = await store.createDocument({
        sourceId: source.id,
        title: 'doc.md',
      });
      const chunk = await store.insertChunk({
        sourceId: source.id,
        documentId: doc.id,
        rank: 0,
        heading: 'h',
        content: 'c',
        rawContent: 'c',
        embedding: null,
      });
      const event = await store.insertEvent({
        sourceId: source.id,
        documentId: doc.id,
        chunkId: chunk.id,
        rank: 0,
        title: 'Test event',
        summary: 'A test',
        content: 'Some content',
        category: 'definition',
        keywords: ['test', 'event'],
        titleEmbedding: new Float32Array([1, 0, 0]),
        contentEmbedding: new Float32Array([0, 1, 0]),
      });
      const found = await store.getEvent(event.id);
      expect(found).toBeDefined();
      expect(found!.title).toBe('Test event');
      expect(found!.keywords).toEqual(['test', 'event']);
    });
  });

  describe('entities', () => {
    it('upserts and dedupes by source+type+name', async () => {
      const source = await store.createSource({ name: 'doc.md' });
      const e1 = await store.upsertEntity({
        sourceId: source.id,
        type: 'person',
        name: 'Alice',
        description: 'first',
        embedding: null,
      });
      const e2 = await store.upsertEntity({
        sourceId: source.id,
        type: 'person',
        name: 'Alice',
        description: 'updated',
        embedding: null,
      });
      expect(e1.id).toBe(e2.id);
      const list = await store.findEntitiesByName('Alice');
      expect(list).toHaveLength(1);
    });

    it('normalizes names for matching', async () => {
      const source = await store.createSource({ name: 'doc.md' });
      await store.upsertEntity({
        sourceId: source.id,
        type: 'organization',
        name: 'Acme Corp',
        description: null,
        embedding: null,
      });
      const found = await store.findEntitiesByName('  acme corp  ');
      expect(found).toHaveLength(1);
    });

    it('rejects invalid entity type', async () => {
      const source = await store.createSource({ name: 'doc.md' });
      await expect(
        store.upsertEntity({
          sourceId: source.id,
          type: 'invalid_type' as never,
          name: 'X',
          description: null,
          embedding: null,
        }),
      ).rejects.toThrow(/invalid entity type/);
    });
  });

  describe('event-entity edges', () => {
    it('finds events by entity and entities by event', async () => {
      const source = await store.createSource({ name: 'doc.md' });
      const doc = await store.createDocument({
        sourceId: source.id,
        title: 'doc.md',
      });
      const chunk = await store.insertChunk({
        sourceId: source.id,
        documentId: doc.id,
        rank: 0,
        heading: 'h',
        content: 'c',
        rawContent: 'c',
        embedding: null,
      });
      const event = await store.insertEvent({
        sourceId: source.id,
        documentId: doc.id,
        chunkId: chunk.id,
        rank: 0,
        title: 'Test',
        summary: null,
        content: 'c',
        category: null,
        keywords: [],
        titleEmbedding: null,
        contentEmbedding: null,
      });
      const entity = await store.upsertEntity({
        sourceId: source.id,
        type: 'person',
        name: 'Bob',
        description: null,
        embedding: null,
      });
      await store.insertEventEntity({
        eventId: event.id,
        entityId: entity.id,
        weight: 1.0,
        description: null,
        embedding: null,
      });
      const events = await store.findEventsByEntity(entity.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.id).toBe(event.id);
      const entities = await store.findEntitiesByEvent(event.id);
      expect(entities).toHaveLength(1);
      expect(entities[0]!.id).toBe(entity.id);
    });
  });

  describe('stats', () => {
    it('counts rows across tables', async () => {
      const source = await store.createSource({ name: 'doc.md' });
      const doc = await store.createDocument({
        sourceId: source.id,
        title: 'doc.md',
      });
      await store.insertChunk({
        sourceId: source.id,
        documentId: doc.id,
        rank: 0,
        heading: 'h',
        content: 'c',
        rawContent: 'c',
        embedding: null,
      });
      const stats = await store.stats();
      expect(stats.sources).toBe(1);
      expect(stats.documents).toBe(1);
      expect(stats.chunks).toBe(1);
      expect(stats.events).toBe(0);
      expect(stats.entities).toBe(0);
    });
  });
});
