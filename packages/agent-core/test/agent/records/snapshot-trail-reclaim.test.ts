/**
 * Superseded `context.snapshot` records must stay on the wire — resuming replays
 * each one's `history` into the replay window, which is how earlier compaction
 * summaries stay visible (see the MEASUREMENT case in wire-reclaim-equivalence).
 * What is dead weight is the `compactedHistory` debug trail each of them
 * carries: restore overwrites it with the LAST snapshot's, and one long session
 * had 16 snapshots of 2–44 MB for under 1 MB of real history. Compaction empties
 * the trail of snapshots that a later snapshot supersedes — and nothing else.
 */
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

async function makeDir(): Promise<string> {
  const dir = join(tmpdir(), `snapshot-trail-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  cleanups.push(dir);
  return dir;
}

const METADATA = { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 };

function message(text: string) {
  return {
    type: 'context.append_message',
    message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [] },
  };
}

/** A snapshot whose live history is one short summary and whose trail is `trailBytes` long. */
function snapshot(summary: string, trailBytes: number) {
  return {
    type: 'context.snapshot',
    snapshot: {
      memory: {},
      forkContext: null,
      history: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: summary }],
          toolCalls: [],
          origin: { kind: 'compaction_summary' },
          id: `m-${summary}`,
        },
      ],
      tokenCount: 10,
      tokenCountCoveredMessageCount: 1,
      openSteps: [],
      pendingToolResultIds: [],
      deferredMessages: [],
    },
    compactedHistory: trailBytes === 0 ? [] : [{ text: 'T'.repeat(trailBytes) }],
  };
}

const line = (value: object, eol = '\n'): string => `${JSON.stringify(value)}${eol}`;

async function writeWire(content: string): Promise<string> {
  const path = join(await makeDir(), 'wire.jsonl');
  await writeFile(path, content, 'utf8');
  return path;
}

function lines(text: string): string[] {
  return text.split('\n').filter((entry) => entry.length > 0);
}

async function resumed(wirePath: string) {
  const copy = join(await makeDir(), 'wire.jsonl');
  await copyFile(wirePath, copy);
  const { agent } = testAgent({ persistence: new FileSystemAgentRecordPersistence(copy) });
  await agent.records.replay();
  return {
    replay: JSON.stringify(agent.replayBuilder.buildResult()),
    history: JSON.stringify(agent.context.history),
    trail: JSON.stringify(agent.fullCompaction.compactedHistory),
  };
}

/** Records between snapshots would be folded away by compaction itself; keep the wire to what this suite is about. */
function threeSnapshotWire(): string {
  return (
    line(METADATA) +
    line(snapshot('summary one', 4_000)) +
    line(snapshot('summary two', 8_000)) +
    line(snapshot('summary three', 12_000)) +
    line(message('tail'))
  );
}

interface WireRecord {
  readonly type: string;
  readonly compactedHistory?: unknown;
  readonly snapshot?: unknown;
}

describe('compaction empties the trail of superseded snapshots', () => {
  it('empties earlier trails, changes nothing else, and keeps the last snapshot byte-identical', async () => {
    const wirePath = await writeWire(threeSnapshotWire());
    const original = lines(await readFile(wirePath, 'utf8'));

    await new FileSystemAgentRecordPersistence(wirePath).compact();

    const after = lines(await readFile(wirePath, 'utf8'));
    const snapshots = after
      .map((entry) => JSON.parse(entry) as WireRecord)
      .filter((record) => record.type === 'context.snapshot');
    expect(snapshots).toHaveLength(3); // none removed: their history feeds the replay window
    expect(snapshots[0]?.compactedHistory).toEqual([]);
    expect(snapshots[1]?.compactedHistory).toEqual([]);
    // History and every other field of the emptied snapshots is untouched.
    expect(snapshots[0]?.snapshot).toEqual((JSON.parse(original[1]!) as WireRecord).snapshot);
    expect(snapshots[1]?.snapshot).toEqual((JSON.parse(original[2]!) as WireRecord).snapshot);
    // The last snapshot is the one restore keeps the trail from: byte-for-byte.
    expect(after.filter((entry) => entry.includes('"summary three"'))).toEqual([original[3]]);
    expect(after.join('\n').length).toBeLessThan(original.join('\n').length - 10_000);
  });

  it('resumes to exactly the same state as the uncompacted wire', async () => {
    const wirePath = await writeWire(threeSnapshotWire());
    const before = await resumed(wirePath);

    await new FileSystemAgentRecordPersistence(wirePath).compact();
    const after = await resumed(wirePath);

    expect(after.history).toBe(before.history);
    expect(after.replay).toBe(before.replay);
    expect(after.trail).toBe(before.trail);
  });

  it('is idempotent: a second compaction leaves the file exactly as it is', async () => {
    const wirePath = await writeWire(threeSnapshotWire());
    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    await persistence.compact();
    const once = await readFile(wirePath, 'utf8');

    await new FileSystemAgentRecordPersistence(wirePath).compact();

    expect(await readFile(wirePath, 'utf8')).toBe(once);
  });

  it('leaves a superseded snapshot whose trail is already empty byte-for-byte alone', async () => {
    const content = line(METADATA) + line(snapshot('one', 0)) + line(snapshot('two', 500));
    const wirePath = await writeWire(content);

    await new FileSystemAgentRecordPersistence(wirePath).compact();

    expect(await readFile(wirePath, 'utf8')).toBe(content);
  });

  it('preserves CRLF framing on a rewritten line', async () => {
    const content =
      line(METADATA, '\r\n') +
      line(snapshot('one', 3_000), '\r\n') +
      line(snapshot('two', 100), '\r\n');
    const wirePath = await writeWire(content);

    await new FileSystemAgentRecordPersistence(wirePath).compact();

    const after = await readFile(wirePath, 'utf8');
    expect(after).toBe(
      line(METADATA, '\r\n') +
        line(snapshot('one', 0), '\r\n') +
        line(snapshot('two', 100), '\r\n'),
    );
  });

  it('does not touch a wire from another protocol version (migration must see every record)', async () => {
    const content =
      line({ ...METADATA, protocol_version: '0.0' }) +
      line(snapshot('one', 3_000)) +
      line(snapshot('two', 100));
    const wirePath = await writeWire(content);

    await new FileSystemAgentRecordPersistence(wirePath).compact();

    expect(await readFile(wirePath, 'utf8')).toBe(content);
  });

  it('counts the reclaimable trail so a resume with no folded records still compacts', async () => {
    const wirePath = await writeWire(
      line(METADATA) + line(snapshot('one', 50_000)) + line(snapshot('two', 100)),
    );
    // A threshold below one emptied snapshot line (~400 bytes): a trail that is
    // already empty must not be counted again, or compaction would re-trigger on
    // every resume for nothing.
    const options = { compactThresholdBytes: 100 };
    const persistence = new FileSystemAgentRecordPersistence(wirePath, options);
    for await (const _record of persistence.read()) {
      // consume
    }

    expect(persistence.shouldCompactOnResume()).toBe(true);
    expect(persistence.droppedBytesOnLastRead()).toBeGreaterThanOrEqual(50_000);

    await persistence.compact();
    const again = new FileSystemAgentRecordPersistence(wirePath, options);
    for await (const _record of again.read()) {
      // consume
    }
    expect(again.droppedBytesOnLastRead()).toBe(0);
    expect(again.shouldCompactOnResume()).toBe(false);
  });
});
