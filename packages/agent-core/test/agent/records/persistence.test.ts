import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_WIRE_PROTOCOL_VERSION,
  BlobStore,
  FileSystemAgentRecordPersistence,
  InMemoryAgentRecordPersistence,
  type AgentRecord,
} from '../../../src/agent/records';

const cleanups: string[] = [];

afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeWirePath(): Promise<string> {
  const dir = join(tmpdir(), `wire-jsonl-test-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  cleanups.push(dir);
  return join(dir, 'wire.jsonl');
}

async function readLines(path: string): Promise<string[]> {
  const raw = await readFile(path, 'utf8');
  return raw.split('\n').filter((line) => line.length > 0);
}

describe('FileSystemAgentRecordPersistence', () => {
  it('writes only the appended record', async () => {
    const wirePath = await makeWirePath();
    const persistence = new FileSystemAgentRecordPersistence(wirePath);

    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'hello' }],
      origin: { kind: 'user' },
    });
    await persistence.close();

    const lines = await readLines(wirePath);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)['type']).toBe('turn.prompt');
  });

  it('appends to an existing file without injecting records', async () => {
    const wirePath = await makeWirePath();

    const first = new FileSystemAgentRecordPersistence(wirePath);
    first.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'one' }],
      origin: { kind: 'user' },
    });
    await first.close();

    const second = new FileSystemAgentRecordPersistence(wirePath);
    second.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'two' }],
      origin: { kind: 'user' },
    });
    await second.close();

    const lines = await readLines(wirePath);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line)['type'])).toEqual([
      'turn.prompt',
      'turn.prompt',
    ]);
  });

  it('returns appended metadata records from read() output', async () => {
    const wirePath = await makeWirePath();
    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    persistence.append({
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
      created_at: 1,
    });
    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'hi' }],
      origin: { kind: 'user' },
    });
    await persistence.close();

    const reader = new FileSystemAgentRecordPersistence(wirePath);
    const records: AgentRecord[] = [];
    for await (const r of reader.read()) records.push(r);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    });
    expect(records[1]!.type).toBe('turn.prompt');
  });

  it('rewrites records from the beginning and then appends after them', async () => {
    const wirePath = await makeWirePath();
    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'old' }],
      origin: { kind: 'user' },
    });
    persistence.rewrite([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'new' }],
        origin: { kind: 'user' },
      },
    ]);
    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'later' }],
      origin: { kind: 'user' },
    });
    await persistence.flush();

    const lines = await readLines(wirePath);
    expect(lines.map((line) => JSON.parse(line)['type'])).toEqual([
      'metadata',
      'turn.prompt',
      'turn.prompt',
    ]);
    expect(JSON.parse(lines[1]!)['input'][0]['text']).toBe('new');
    expect(JSON.parse(lines[2]!)['input'][0]['text']).toBe('later');
  });

  it('rewrites already flushed records from the beginning', async () => {
    const wirePath = await makeWirePath();
    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'old' }],
      origin: { kind: 'user' },
    });
    await persistence.flush();

    persistence.rewrite([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'new' }],
        origin: { kind: 'user' },
      },
    ]);
    await persistence.flush();

    const lines = await readLines(wirePath);
    expect(lines.map((line) => JSON.parse(line)['type'])).toEqual([
      'metadata',
      'turn.prompt',
    ]);
    expect(JSON.parse(lines[1]!)['input'][0]['text']).toBe('new');
  });

  it('flushes pending records on close', async () => {
    const wirePath = await makeWirePath();
    const persistence = new FileSystemAgentRecordPersistence(wirePath);

    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'late' }],
      origin: { kind: 'user' },
    });
    await persistence.close();

    const lines = await readLines(wirePath);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)['type']).toBe('turn.prompt');
  });

  it('enters error state after a write failure', async () => {
    const wirePath = await makeWirePath();
    await mkdir(wirePath);
    const persistence = new FileSystemAgentRecordPersistence(wirePath);

    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'first' }],
      origin: { kind: 'user' },
    });
    await expect(persistence.flush()).rejects.toBeInstanceOf(Error);

    expect(() => {
      persistence.append({
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'second' }],
        origin: { kind: 'user' },
      });
    }).toThrow();
    expect(() => {
      persistence.rewrite([
        {
          type: 'turn.prompt',
          input: [{ type: 'text', text: 'rewrite' }],
          origin: { kind: 'user' },
        },
      ]);
    }).toThrow();
    await expect(persistence.flush()).rejects.toBeInstanceOf(Error);
  });

  it('offloads large data URIs to blobsDir during append', async () => {
    const dir = join(tmpdir(), `wire-blob-test-${randomBytes(6).toString('hex')}`);
    await mkdir(dir, { recursive: true });
    cleanups.push(dir);

    const wirePath = join(dir, 'wire.jsonl');
    const blobsDir = join(dir, 'blobs');
    const persistence = new FileSystemAgentRecordPersistence(wirePath, {
      blobStore: new BlobStore({ blobsDir }),
    });

    const payload = 'X'.repeat(5000);
    const dataUri = `data:image/png;base64,${payload}`;

    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: dataUri } }],
      origin: { kind: 'user' },
    });
    await persistence.close();

    const lines = await readLines(wirePath);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as unknown as Record<string, unknown>;
    const url = ((record['input'] as unknown[])[0] as { imageUrl: { url: string } }).imageUrl.url;
    expect(url.startsWith('blobref:')).toBe(true);

    const blobFiles = await readdir(blobsDir);
    expect(blobFiles).toHaveLength(1);
    expect((await readFile(join(blobsDir, blobFiles[0]!))).toString('base64')).toBe(payload);
  });
});

describe('InMemoryAgentRecordPersistence', () => {
  it('stores appended records and replaces them on rewrite', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'one' }],
      origin: { kind: 'user' },
    });
    persistence.rewrite([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
    ]);

    const records: AgentRecord[] = [];
    for await (const record of persistence.read()) records.push(record);

    expect(records).toEqual([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
    ]);
    expect(persistence.records).toEqual(records);
  });
});


describe('snapshot parse-skipping (read fast path)', () => {
  const METADATA = {
    type: 'metadata',
    protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    created_at: 1,
  };

  function foldedMessage(text: string) {
    return {
      type: 'context.append_message',
      message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [] },
    };
  }

  function snapshotRecord() {
    return {
      type: 'context.snapshot',
      snapshot: { memory: {}, forkContext: null },
      compactedHistory: [],
    };
  }

  async function writeFixture(lines: object[]): Promise<string> {
    const wirePath = await makeWirePath();
    await writeFile(wirePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    return wirePath;
  }

  async function readTypes(wirePath: string): Promise<string[]> {
    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    const records: AgentRecord[] = [];
    for await (const record of persistence.read()) records.push(record);
    return records.map((r) => r.type);
  }

  it('skips folded records predating the last snapshot without parsing them', async () => {
    const wirePath = await writeFixture([
      METADATA,
      foldedMessage('old question'), // folded into the snapshot below
      { type: 'context.apply_compaction', keep: [] }, // also folded
      snapshotRecord(),
      foldedMessage('new question'), // after the snapshot — NOT skipped
      { type: 'turn.prompt', input: [{ type: 'text', text: 'next' }], origin: { kind: 'user' } },
    ]);

    expect(await readTypes(wirePath)).toEqual([
      'metadata',
      'context.snapshot',
      'context.append_message',
      'turn.prompt',
    ]);
  });

  it('still parses everything when the wire version differs (migration path)', async () => {
    const wirePath = await writeFixture([
      { ...METADATA, protocol_version: Number(AGENT_WIRE_PROTOCOL_VERSION) - 1 },
      foldedMessage('old question'),
      snapshotRecord(),
    ]);

    // Version mismatch requires a full rewrite that migrates every record,
    // so skipping must be disabled.
    expect(await readTypes(wirePath)).toEqual([
      'metadata',
      'context.append_message',
      'context.snapshot',
    ]);
  });

  it('parses everything when the file has no snapshot', async () => {
    const wirePath = await writeFixture([
      METADATA,
      foldedMessage('q1'),
      { type: 'context.apply_compaction', keep: [] },
    ]);

    expect(await readTypes(wirePath)).toEqual([
      'metadata',
      'context.append_message',
      'context.apply_compaction',
    ]);
  });

  it('keeps records containing U+2028/U+2029 line separators intact', async () => {
    // Unicode line separators inside JSON string content must NOT split a
    // record — only "\n" (0x0A) terminates a wire line. node:readline-based
    // splitting would cut these in half and fail to parse.
    const separatorMessage = {
      type: 'turn.prompt',
      input: [{ type: 'text', text: '行内分隔符\u{2028}第二行\u{2029}第三行' }],
      origin: { kind: 'user' },
    };
    const raw =
      JSON.stringify(METADATA) + '\n' + JSON.stringify(separatorMessage) + '\n';
    const wirePath = await makeWirePath();
    await writeFile(wirePath, raw, 'utf8');

    expect(await readTypes(wirePath)).toEqual(['metadata', 'turn.prompt']);
    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    for await (const record of persistence.read()) {
      if (record.type === 'turn.prompt') {
        expect(
          (
            record as Extract<AgentRecord, { type: 'turn.prompt' }>).input[0],
        ).toMatchObject({ text: '行内分隔符\u{2028}第二行\u{2029}第三行' });
      }
    }
  });

  it('tolerates CRLF line endings and unterminated trailing lines', async () => {
    const first = { type: 'turn.prompt', input: [{ type: 'text', text: 'crlf line' }], origin: { kind: 'user' } };
    // Trailing partial record without a newline: tolerated as allowTruncated.
    const partial = '{"type":"turn.prompt","input":[{"type":"text","text":"trunc';
    const raw = JSON.stringify(METADATA) + '\r\n' + JSON.stringify(first) + '\r\n' + partial;
    const wirePath = await makeWirePath();
    await writeFile(wirePath, raw, 'utf8');

    expect(await readTypes(wirePath)).toEqual(['metadata', 'turn.prompt']);
  });

  it('handles multi-chunk oversized lines spanning hundreds of stream chunks', async () => {
    // A single multi-megabyte record exercises the cross-chunk open-line
    // assembly path (the quadratic-scan regression this guards against).
    const bigText = 'x'.repeat(3 * 1024 * 1024);
    const bigRecord = {
      type: 'turn.prompt',
      input: [{ type: 'text', text: bigText }],
      origin: { kind: 'user' },
    };
    const wirePath = await makeWirePath();
    await writeFile(wirePath, JSON.stringify(METADATA) + '\n' + JSON.stringify(bigRecord) + '\n', 'utf8');

    expect(await readTypes(wirePath)).toEqual(['metadata', 'turn.prompt']);
  });
});
