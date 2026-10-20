import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { zipSync } from 'fflate';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ingestDirectory, ingestFile, isSupportedFile, stripImagePlaceholders } from '../src/ingest.js';
import { KnowledgeStore } from '../src/store.js';
import type { EmbeddingEngine, LlmCaller } from '../src/types.js';

const encoder = new TextEncoder();

function makeEngine(): EmbeddingEngine {
  return {
    modelName: 'format-stub',
    available: true,
    async embedBatch(texts: string[]): Promise<Float32Array[] | null> {
      return texts.map((text) => {
        const vec = new Float32Array(8);
        for (let i = 0; i < text.length; i++) vec[i % 8]! += ((text.codePointAt(i) ?? 0) % 7) + 1;
        return vec;
      });
    },
    cosineSimilarity(a: Float32Array, b: Float32Array): number {
      if (a.length !== b.length || a.length === 0) return 0;
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!;
        normA += a[i]! * a[i]!;
        normB += b[i]! * b[i]!;
      }
      const denom = Math.sqrt(normA) * Math.sqrt(normB);
      return denom === 0 ? 0 : dot / denom;
    },
    async ensureReady(): Promise<boolean> {
      return true;
    },
  };
}

function makeLlm(): LlmCaller {
  return {
    async generate(systemPrompt: string) {
      if (systemPrompt.includes('knowledge content extractor')) {
        return JSON.stringify({
          items: [
            {
              title: 'Doc Event',
              summary: 'S',
              content: 'content',
              category: 'definition',
              keywords: ['doc'],
              entities: [{ type: 'subject', name: 'Doc', description: 'the document' }],
            },
          ],
        });
      }
      return '';
    },
  };
}

/** Minimal OOXML package that mammoth can read. */
function buildDocx(bodyText: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': encoder.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    ),
    '_rels/.rels': encoder.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    ),
    'word/document.xml': encoder.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p>
</w:body></w:document>`,
    ),
  });
}

/** Minimal OOXML spreadsheet with an inline-string cell. */
function buildXlsx(cellText: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': encoder.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
    ),
    '_rels/.rels': encoder.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    ),
    'xl/workbook.xml': encoder.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': encoder.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
    ),
    'xl/worksheets/sheet1.xml': encoder.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>${cellText}</t></is></c></row>
</sheetData></worksheet>`,
    ),
  });
}

function escapePdfText(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

/** Minimal single-page PDF with a Helvetica text object and a valid xref. */
function buildPdf(lines: string[]): Uint8Array {
  const content = lines
    .map((line, index) => `BT /F1 18 Tf 72 ${720 - index * 24} Td (${escapePdfText(line)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

describe('binary document ingestion', () => {
  let tmpDir: string;
  let docDir: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-knowledge-formats-'));
    docDir = await mkdtemp(join(tmpdir(), 'scream-format-docs-'));
    store = new KnowledgeStore(tmpDir);
    await store.init();
    store.setEmbeddingEngine(makeEngine());
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    await rm(docDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('ingests a .docx as text', async () => {
    const filePath = join(docDir, 'report.docx');
    await writeFile(filePath, buildDocx('Quarterly revenue grew twelve percent'));

    const result = await ingestFile(store, makeLlm(), filePath);

    expect(result.outcome).toBe('created');
    expect(result.chunkCount).toBeGreaterThan(0);
    const doc = await store.getDocument(result.documentId!);
    expect(doc?.content).toContain('Quarterly revenue grew twelve percent');
  });

  it('ingests a .xlsx as text', async () => {
    const filePath = join(docDir, 'sheet.xlsx');
    await writeFile(filePath, buildXlsx('Region revenue'));

    const result = await ingestFile(store, makeLlm(), filePath);

    expect(result.outcome).toBe('created');
    expect(result.chunkCount).toBeGreaterThan(0);
    const doc = await store.getDocument(result.documentId!);
    expect(doc?.content).toContain('Region revenue');
  });

  it('ingests a .pdf as text', async () => {
    const filePath = join(docDir, 'brief.pdf');
    await writeFile(filePath, buildPdf(['Retrieval handbook', 'Second line of the brief']));

    const result = await ingestFile(store, makeLlm(), filePath);

    expect(result.outcome).toBe('created');
    expect(result.chunkCount).toBeGreaterThan(0);
    const doc = await store.getDocument(result.documentId!);
    expect(doc?.content).toMatch(/Retrieval handbook/);
  });

  it('rejects a PDF without a text layer', async () => {
    const filePath = join(docDir, 'scan.pdf');
    await writeFile(filePath, buildPdf([]));

    await expect(ingestFile(store, makeLlm(), filePath)).rejects.toThrow(/未提取到文字/);
    expect(await store.listDocuments()).toHaveLength(0);
  });

  it('rejects formats outside the whitelist at the library boundary', async () => {
    const filePath = join(docDir, 'slides.pptx');
    await writeFile(filePath, 'not really a deck');

    expect(isSupportedFile(filePath)).toBe(false);
    await expect(ingestFile(store, makeLlm(), filePath)).rejects.toThrow(/不支持的文件类型/);
  });

  it('rejects an oversized binary document before reading it', async () => {
    const filePath = join(docDir, 'huge.pdf');
    await writeFile(filePath, '%PDF-1.4\n');
    await truncate(filePath, 51 * 1024 * 1024);

    await expect(ingestFile(store, makeLlm(), filePath)).rejects.toThrow(/50MB/);
  });

  it('keeps the previous version when a changed document fails to convert', async () => {
    const filePath = join(docDir, 'brief.pdf');
    await writeFile(filePath, buildPdf(['Stable body']));
    expect((await ingestFile(store, makeLlm(), filePath)).outcome).toBe('created');

    // Same path, no text layer: the new conversion fails, so the old version
    // must survive instead of being deleted first.
    await writeFile(filePath, buildPdf([]));
    await expect(ingestFile(store, makeLlm(), filePath)).rejects.toThrow(/未提取到文字/);

    const docs = await store.listDocuments();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.content).toContain('Stable body');
  });

  it('strips converter image placeholders before chunking', () => {
    const markdown = 'Title\n\n<!-- image: img_0 (page 1, 120x80pt) -->\n\n\n\nBody';
    expect(stripImagePlaceholders(markdown)).toBe('Title\n\nBody');
  });

  it('scans a directory for text and PDF only, skipping Office temp files', async () => {
    await writeFile(join(docDir, 'notes.md'), '# Notes\n\nplain markdown body');
    await writeFile(join(docDir, 'brief.pdf'), buildPdf(['Directory scan body']));
    await writeFile(join(docDir, 'slides.pptx'), 'skip me');
    await writeFile(join(docDir, '~$report.docx'), 'lock file');

    const result = await ingestDirectory(store, makeLlm(), docDir);

    expect(result.created).toBe(2);
    expect(result.failed).toBe(0);
    const names = (await store.listDocuments()).map((doc) => doc.sourceName ?? '').toSorted();
    expect(names.some((name) => name.includes('notes.md'))).toBe(true);
    expect(names.some((name) => name.includes('brief.pdf'))).toBe(true);
  });

  it('fingerprints binary documents by their bytes', async () => {
    const filePath = join(docDir, 'report.docx');
    await writeFile(filePath, buildDocx('First revision body'));
    const first = await ingestFile(store, makeLlm(), filePath);
    expect(first.outcome).toBe('created');

    // Identical bytes → unchanged, no re-extraction.
    expect((await ingestFile(store, makeLlm(), filePath)).outcome).toBe('unchanged');

    await writeFile(filePath, buildDocx('Second revision body'));
    expect((await ingestFile(store, makeLlm(), filePath)).outcome).toBe('updated');
  });
});
