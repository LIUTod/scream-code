import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_WIRE_PROTOCOL_VERSION,
  FileSystemAgentRecordPersistence,
} from '../../../src/agent/records';
import { testAgent } from '../harness/agent';

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function writeRawWire(content: string): Promise<string> {
  const dir = join(tmpdir(), `compact-on-resume-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  cleanups.push(dir);
  const wirePath = join(dir, 'wire.jsonl');
  await writeFile(wirePath, content, 'utf8');
  return wirePath;
}

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
    snapshot: {
      memory: {},
      forkContext: null,
      // Fields restoreJSONSnapshot() iterates over — kept minimal but complete
      // so a full replay can restore this snapshot.
      history: [],
      tokenCount: 0,
      tokenCountCoveredMessageCount: 0,
      openSteps: [],
      pendingToolResultIds: [],
      deferredMessages: [],
    },
    compactedHistory: [],
  };
}

const jsonLine = (value: object): string => `${JSON.stringify(value)}\n`;

describe('wire compaction on resume', () => {
  it('replay() compacts automatically past the configured watermark', async () => {
    const wirePath = await writeRawWire(
      jsonLine(METADATA) +
        jsonLine(foldedMessage('old question')) +
        jsonLine(snapshotRecord()) +
        jsonLine(foldedMessage('new question')),
    );
    const persistence = new FileSystemAgentRecordPersistence(wirePath, {
      compactThresholdBytes: 64,
    });
    const sizeBefore = (await readFile(wirePath)).length;

    const { agent } = testAgent({ persistence });
    await agent.records.replay();

    const after = (await readFile(wirePath)).length;
    // The folded record is physically gone, not just skipped in memory.
    expect(after).toBeLessThan(sizeBefore);
    expect(persistence.droppedBytesOnLastRead()).toBe(0);

    // A second resume over the compacted wire sees nothing to fold and does
    // not rewrite it again.
    const persistence2 = new FileSystemAgentRecordPersistence(wirePath, {
      compactThresholdBytes: 64,
    });
    const { agent: agent2 } = testAgent({ persistence: persistence2 });
    await agent2.records.replay();
    expect(persistence2.droppedBytesOnLastRead()).toBe(0);
    expect((await readFile(wirePath)).length).toBe(after);
    expect(JSON.stringify(agent2.replayBuilder.buildResult())).toBe(
      JSON.stringify(agent.replayBuilder.buildResult()),
    );
  });

  it('reports the exact folded byte count', async () => {
    const wirePath = await writeRawWire(
      jsonLine(METADATA) +
        jsonLine(foldedMessage('old question')) +
        jsonLine({ type: 'context.apply_compaction', keep: [] }) +
        jsonLine(snapshotRecord()) +
        jsonLine(foldedMessage('new question')),
    );
    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    for await (const _record of persistence.read()) {
      // consume
    }
    const expected =
      Buffer.byteLength(jsonLine(foldedMessage('old question')), 'utf8') +
      Buffer.byteLength(jsonLine({ type: 'context.apply_compaction', keep: [] }), 'utf8');
    expect(persistence.droppedBytesOnLastRead()).toBe(expected);
  });

  it('compacts CRLF frames without touching retained bytes', async () => {
    const crlf = (value: object): string => `${JSON.stringify(value)}\r\n`;
    const wirePath = await writeRawWire(
      crlf(METADATA) + crlf(foldedMessage('old question')) + crlf(snapshotRecord()),
    );
    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    for await (const _record of persistence.read()) {
      // consume
    }
    await persistence.compact();

    const after = await readFile(wirePath, 'utf8');
    expect(after).toBe(crlf(METADATA) + crlf(snapshotRecord()));
  });

  it('compacts a wire whose last retained line has no trailing newline', async () => {
    const tailWithoutNewline = JSON.stringify({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'x' }],
      origin: { kind: 'user' },
    });
    const wirePath = await writeRawWire(
      jsonLine(METADATA) + jsonLine(foldedMessage('old question')) + jsonLine(snapshotRecord()) + tailWithoutNewline,
    );
    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    for await (const _record of persistence.read()) {
      // consume
    }
    await persistence.compact();

    const after = await readFile(wirePath, 'utf8');
    expect(after.endsWith(tailWithoutNewline)).toBe(true);
    expect(after).not.toContain('old question');
  });

  it('folds short lines that match the fold prefix, same as read()', async () => {
    // A line that starts with a folded type but is malformed is dropped by
    // both paths: read()'s fold decision matches on the prefix, and the
    // compacting pass deletes exactly the lines read() would skip.
    const stub = '{"type":"context.append_message"}\n';
    const wirePath = await writeRawWire(
      jsonLine(METADATA) + stub + jsonLine(snapshotRecord()) + jsonLine(foldedMessage('new')),
    );
    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    for await (const _record of persistence.read()) {
      // consume
    }
    await persistence.compact();

    const after = await readFile(wirePath, 'utf8');
    expect(after).not.toContain(stub);
    expect(after).toContain('"new"'); // the post-snapshot record survives
  });
});
