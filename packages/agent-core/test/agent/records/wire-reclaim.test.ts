import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_WIRE_PROTOCOL_VERSION,
  FileSystemAgentRecordPersistence,
  InMemoryAgentRecordPersistence,
  type AgentRecord,
} from '../../../src/agent/records';
import { testAgent } from '../harness/agent';

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function writeRawWire(records: readonly AgentRecord[]): Promise<string> {
  return writeRawText(records.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

/** Write an arbitrary byte-exact wire body (used for unterminated-tail cases). */
async function writeRawText(content: string): Promise<string> {
  const dir = join(tmpdir(), `wire-reclaim-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(dir, { recursive: true });
  cleanups.push(dir);
  const wirePath = join(dir, 'wire.jsonl');
  await writeFile(wirePath, content, 'utf8');
  return wirePath;
}

const METADATA: AgentRecord = {
  type: 'metadata',
  protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
  created_at: 1,
};

const draft = (turnId: string, text: string, think = ''): AgentRecord => ({
  type: 'context.stream_draft',
  turnId,
  text,
  think,
});

const message = (text: string): AgentRecord => ({
  type: 'context.append_message',
  message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [] },
});

function snapshot(tag: string): AgentRecord {
  return {
    type: 'context.snapshot',
    snapshot: {
      memory: {},
      forkContext: null,
      history: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: tag }],
          toolCalls: [],
          origin: { kind: 'compaction_summary' },
        },
      ],
      tokenCount: 10,
      tokenCountCoveredMessageCount: 1,
      openSteps: [],
      pendingToolResultIds: [],
      deferredMessages: [],
    },
    compactedHistory: [{ text: tag }],
  } as unknown as AgentRecord;
}

/**
 * A wire with two snapshots, drafts before AND after the last one, and a
 * post-snapshot message that must survive. This is the shape the live path
 * produces across repeated compactions.
 */
function buildWire(): AgentRecord[] {
  return [
    METADATA,
    message('folded q1'),
    draft('1', 'draft before s1'),
    draft('1', ''),
    snapshot('s1'),
    message('folded q2'),
    draft('2', 'draft before s2'),
    draft('2', 'draft before s2 (later)'),
    draft('2', ''),
    snapshot('s2'),
    message('kept q3'),
    draft('3', 'uncleared draft after s2', 'think after s2'),
  ];
}

/**
 * The lines a same-version read()/compact() must keep, in file order. Spelled
 * out literally rather than derived from the predicates: the point is to pin the
 * observable outcome, so a change in either rule must fail this test.
 *
 * Dropped: `message('folded q1')` and `message('folded q2')` (folded, pre-last-
 * snapshot), plus every draft that is NOT its turn's last one. Retained: the
 * metadata header, each turn's LAST draft (turns 1 and 2 clear theirs, turn 3's
 * is the uncleared post-snapshot one), both snapshots (only the LAST one is the
 * restore point; reclaiming the earlier one is a separate, not-landed change),
 * and the post-snapshot message.
 */
function expectedRetainedLines(): string[] {
  return [
    METADATA,
    draft('1', ''),
    snapshot('s1'),
    draft('2', ''),
    snapshot('s2'),
    message('kept q3'),
    draft('3', 'uncleared draft after s2', 'think after s2'),
  ].map((record) => JSON.stringify(record));
}

describe('reclaiming intermediate stream drafts', () => {
  it('read() keeps only the last draft per turnId, folding the rest', async () => {
    const wire = buildWire();
    const persistence = new InMemoryAgentRecordPersistence(wire);
    const seen: AgentRecord[] = [];
    for await (const record of persistence.read()) seen.push(record);

    const drafts = seen.filter((record) => record.type === 'context.stream_draft');
    // Turn 1's and turn 2's LAST drafts are their cleared markers; both are
    // pre-snapshot but still survive, because a blanket pre-snapshot fold would
    // also have removed an uncleared aborted-stream draft (see
    // wire-reclaim-equivalence.test.ts for that regression guard).
    expect(drafts).toEqual([draft('1', ''), draft('2', ''), draft('3', 'uncleared draft after s2', 'think after s2')]);
    // read() yields exactly the lines compact() keeps (both snapshots are
    // retained: reclaiming the earlier one is NOT landed — see
    // wire-reclaim-equivalence.test.ts for the measurement that blocked it).
    expect(seen.map((record) => JSON.stringify(record))).toEqual(expectedRetainedLines());
  });

  it('read() and compact() retain exactly the same lines of the same wire', async () => {
    const wire = buildWire();
    const wirePath = await writeRawWire(wire);
    const persistence = new FileSystemAgentRecordPersistence(wirePath);

    const fromFile: string[] = [];
    for await (const record of persistence.read()) fromFile.push(JSON.stringify(record));

    await persistence.compact();

    const onDisk = (await readFile(wirePath, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0);
    const expected = expectedRetainedLines();

    expect(onDisk).toEqual(expected);
    // read() yields the same set of lines as the file retains — same fold
    // decision in both passes, no drift between them.
    expect(fromFile).toEqual(expected);

    // The in-memory reader agrees with the file reader.
    const inMemory: string[] = [];
    for await (const record of new InMemoryAgentRecordPersistence(wire).read()) {
      inMemory.push(JSON.stringify(record));
    }
    expect(inMemory).toEqual(expected);

    // ...and it is still a resumable wire.
    const resumed = testAgent({
      persistence: new FileSystemAgentRecordPersistence(wirePath),
    });
    await resumed.agent.records.replay();
    expect(
      resumed.agent.replayBuilder
        .buildResult()
        .filter((record) => record.type === 'stream_draft_partial'),
    ).toEqual([
      {
        type: 'stream_draft_partial',
        turnId: '3',
        text: 'uncleared draft after s2',
        think: 'think after s2',
      },
    ]);
  });

  it('never reclaims the last context.snapshot (it is the restore point)', async () => {
    const wire = buildWire();
    const wirePath = await writeRawWire(wire);
    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    for await (const _record of persistence.read()) {
      // consume
    }
    await persistence.compact();

    const onDisk = (await readFile(wirePath, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0);
    const snapshots = onDisk.filter((line) => line.startsWith('{"type":"context.snapshot"'));
    // The wire has two snapshots; the last one is the restore point and stays,
    // the earlier one is NOT reclaimed yet (step-2 candidate, not landed).
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)).toBe(JSON.stringify(snapshot('s2')));
  });
});

describe('reclaiming intermediate drafts on snapshot-less wires', () => {
  /**
   * The dominant live shape: most wires never compact, so they have NO
   * snapshot — yet streaming writes several drafts per turn. Every draft but
   * the last one per turnId is unobservable on resume
   * (ReplayBuilder.replacePartialDraft replaces in place), so all of them
   * except the final draft per turn must be reclaimed.
   */
  function buildDraftHeavyWire(): AgentRecord[] {
    return [
      METADATA,
      message('q1'),
      draft('1', 'turn 1 part a'),
      draft('1', 'turn 1 part b'),
      draft('1', 'turn 1 part c'),
      message('q2'),
      draft('2', 'turn 2 only draft'),
      draft('3', 'turn 3 part a'),
      draft('3', ''),
    ];
  }

  function expectedDraftHeavyRetained(): string[] {
    return [
      METADATA,
      message('q1'),
      draft('1', 'turn 1 part c'),
      message('q2'),
      draft('2', 'turn 2 only draft'),
      // turn 3's last draft is the clearing marker (''), which must survive:
      // it is what removes the partial from the replay window on resume.
      draft('3', ''),
    ].map((record) => JSON.stringify(record));
  }

  it('read() keeps only the last draft per turnId even without any snapshot', async () => {
    const wire = buildDraftHeavyWire();
    const persistence = new InMemoryAgentRecordPersistence(wire);
    const seen: AgentRecord[] = [];
    for await (const record of persistence.read()) seen.push(record);
    expect(seen.map((record) => JSON.stringify(record))).toEqual(expectedDraftHeavyRetained());
  });

  it('read() and compact() agree on the snapshot-less wire, and it still resumes', async () => {
    const wire = buildDraftHeavyWire();
    const wirePath = await writeRawWire(wire);
    const persistence = new FileSystemAgentRecordPersistence(wirePath);

    const fromFile: string[] = [];
    for await (const record of persistence.read()) fromFile.push(JSON.stringify(record));

    await persistence.compact();
    const onDisk = (await readFile(wirePath, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0);
    const expected = expectedDraftHeavyRetained();
    expect(onDisk).toEqual(expected);
    expect(fromFile).toEqual(expected);

    const resumed = testAgent({
      persistence: new FileSystemAgentRecordPersistence(wirePath),
    });
    await resumed.agent.records.replay();
    const partials = resumed.agent.replayBuilder
      .buildResult()
      .filter((record) => record.type === 'stream_draft_partial');
    // Full recovery of observable state: turn 1's last draft, turn 2's only
    // draft, and turn 3's clearing marker (which removes its partial).
    expect(partials).toEqual([
      { type: 'stream_draft_partial', turnId: '1', text: 'turn 1 part c', think: '' },
      { type: 'stream_draft_partial', turnId: '2', text: 'turn 2 only draft', think: '' },
    ]);
  });

  it('an unterminated trailing draft is recognised as its turn last draft on both paths', async () => {
    // A crash mid-append leaves the wire without a final newline. The streaming
    // passes classify that tail as line `lineNumber + 1`, so the pre-scan must
    // too — otherwise the newest in-flight state is mistaken for an
    // intermediate draft and dropped.
    const wire = [METADATA, draft('1', 'part a'), draft('1', 'tail part b')];
    const raw = `${wire.map((record) => JSON.stringify(record)).join('\n')}\n`.slice(
      0,
      -1,
    ); // drop the final newline
    const wirePath = await writeRawText(raw);

    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    const fromFile: string[] = [];
    for await (const record of persistence.read()) fromFile.push(JSON.stringify(record));
    expect(fromFile).toEqual([METADATA, draft('1', 'tail part b')].map((r) => JSON.stringify(r)));

    await persistence.compact();
    const onDisk = (await readFile(wirePath, 'utf8')).split('\n').filter((line) => line.length > 0);
    expect(onDisk).toEqual([METADATA, draft('1', 'tail part b')].map((r) => JSON.stringify(r)));
  });

  it('a torn trailing line never shadows the turn last complete draft', async () => {
    // A crash mid-flush can leave a PARTIAL final line. The streaming passes
    // cannot parse it (no record is produced), so the pre-scan must not register
    // it either — otherwise it would count as the turn's "last draft" and the
    // last COMPLETE draft would be reclaimed, destroying exactly the in-flight
    // state this rule exists to preserve.
    const wire = [METADATA, draft('1', 'complete draft')];
    const torn = '{"type":"context.stream_draft","turnId":"1","text":"torn hel';
    const wirePath = await writeRawText(
      `${wire.map((record) => JSON.stringify(record)).join('\n')}\n${torn}`,
    );

    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    const fromFile: string[] = [];
    for await (const record of persistence.read()) fromFile.push(JSON.stringify(record));
    // The complete draft survives; the torn line yields no record at all.
    expect(fromFile).toEqual([METADATA, draft('1', 'complete draft')].map((r) => JSON.stringify(r)));

    await persistence.compact();
    const onDisk = (await readFile(wirePath, 'utf8')).split('\n').filter((line) => line.length > 0);
    expect(onDisk).toEqual([METADATA, draft('1', 'complete draft')].map((r) => JSON.stringify(r)));
  });

  it('a version-mismatched wire yields every record, drafts included', async () => {
    // Migration must see the whole wire: when the header version differs, no
    // reclaim rule may run. The file path has to match
    // InMemoryAgentRecordPersistence.read(), which yields the raw records
    // verbatim in that case — otherwise a migration rewrite would silently drop
    // drafts on disk that the in-memory path kept.
    const staleHeader = {
      type: 'metadata',
      protocol_version: '0.0',
      created_at: 1,
    } as unknown as AgentRecord;
    const wire = [staleHeader, draft('1', 'first'), draft('1', 'last'), draft('2', 'other')];
    const wirePath = await writeRawWire(wire);

    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    const fromFile: string[] = [];
    for await (const record of persistence.read()) fromFile.push(JSON.stringify(record));
    expect(fromFile).toEqual(wire.map((r) => JSON.stringify(r)));

    await persistence.compact();
    const onDisk = (await readFile(wirePath, 'utf8')).split('\n').filter((line) => line.length > 0);
    expect(onDisk).toEqual(wire.map((r) => JSON.stringify(r)));
  });
});
