import { describe, expect, it } from 'vitest';

import type { CompactionResult } from '../../../src/agent/compaction';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  InMemoryAgentRecordPersistence,
  type AgentRecord,
} from '../../../src/agent/records';
import { testAgent } from '../harness/agent';

const METADATA: AgentRecord = {
  type: 'metadata',
  protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
  created_at: 1,
};

function userMessage(text: string): AgentRecord {
  return {
    type: 'context.append_message',
    message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [] },
  };
}

function compaction(summary: string, compactedCount: number, tokensAfter: number): CompactionResult {
  return {
    summary,
    compactedCount,
    tokensBefore: 10_000,
    tokensAfter,
  };
}

/**
 * Simulates the disk round-trip a real session goes through: the wire records
 * are serialized to JSON and parsed back. Unlike `structuredClone`, this breaks
 * object-reference identity (the property the snapshot implementation must
 * restore explicitly), so these tests exercise the real resume path.
 */
function diskRoundTrip(records: readonly AgentRecord[]): AgentRecord[] {
  return JSON.parse(JSON.stringify(records)) as AgentRecord[];
}

function replayWire(wire: readonly AgentRecord[]) {
  return testAgent({
    persistence: new InMemoryAgentRecordPersistence(diskRoundTrip(wire)),
  });
}

/**
 * Builds the wire a live session would have produced: metadata, a burst of
 * context appends, a full compaction (which now also logs a `context.snapshot`),
 * then a few incremental appends. Returns the records exactly as persisted.
 */
function buildLiveWire(): AgentRecord[] {
  const persistence = new InMemoryAgentRecordPersistence();
  const ctx = testAgent({ persistence });

  ctx.agent.context.appendUserMessage([{ type: 'text', text: 'first question' }]);
  ctx.agent.context.appendUserMessage([{ type: 'text', text: 'second question' }]);
  ctx.agent.context.appendUserMessage([{ type: 'text', text: 'third question' }]);

  // Full compaction folds the three user messages into a summary and logs a
  // `context.snapshot` of the folded memory.
  ctx.agent.context.applyCompaction(compaction('summary of first three', 3, 500));

  // Incremental appends after the snapshot.
  ctx.agent.context.appendUserMessage([{ type: 'text', text: 'after compaction' }]);

  return persistence.records;
}

describe('AgentRecords context snapshot replay', () => {
  it('writes a context.snapshot record right after apply_compaction', () => {
    const wire = buildLiveWire();
    const types = wire.map((record) => record.type);
    const compactionIdx = types.indexOf('context.apply_compaction');
    expect(compactionIdx).toBeGreaterThan(-1);
    expect(types[compactionIdx + 1]).toBe('context.snapshot');
  });

  it('restores identical context state whether replaying through the snapshot or in full', async () => {
    const liveWire = buildLiveWire();

    // Snapshot replay: the live wire contains the snapshot record.
    const withSnapshot = replayWire(liveWire);
    await withSnapshot.agent.records.replay();

    // Full replay: same wire but with every context.snapshot record removed,
    // forcing the legacy record-by-record path.
    const withoutSnapshotWire = liveWire.filter((record) => record.type !== 'context.snapshot');
    const withoutSnapshot = replayWire(withoutSnapshotWire);
    await withoutSnapshot.agent.records.replay();

    expect(withSnapshot.agent.context.data()).toEqual(withoutSnapshot.agent.context.data());
  });

  it('skips folded context records but still applies metadata and incremental records', async () => {
    const liveWire = buildLiveWire();
    const snapshotIdx = liveWire.findIndex((record) => record.type === 'context.snapshot');
    expect(snapshotIdx).toBeGreaterThan(-1);

    const ctx = replayWire(liveWire);
    await ctx.agent.records.replay();

    // The folded history is the summary message plus the incremental append.
    const history = ctx.agent.context.history;
    expect(history).toHaveLength(2);
    expect(history[0]?.content[0]).toMatchObject({ type: 'text', text: 'summary of first three' });
    expect(history[1]?.content[0]).toMatchObject({ type: 'text', text: 'after compaction' });
    expect(ctx.agent.context.tokenCount).toBe(500);
  });

  it('replays normally when no snapshot exists (legacy sessions)', async () => {
    const wire: AgentRecord[] = [METADATA, userMessage('hello'), userMessage('world')];
    const ctx = replayWire(wire);
    await ctx.agent.records.replay();

    expect(ctx.agent.context.history).toHaveLength(2);
  });

  it('restores open-step reference identity across the disk round-trip', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'user prompt' }]);
    // An in-flight step: step.begin pushes an assistant message into history AND
    // registers the same object as the open step. content.part then mutates that
    // object, which the history also references.
    ctx.agent.context.appendLoopEvent({
      type: 'step.begin',
      uuid: 'step-1',
      turnId: 'turn-1',
      step: 0,
    });
    ctx.agent.context.appendLoopEvent({
      type: 'content.part',
      uuid: 'step-1',
      stepUuid: 'step-1',
      turnId: 'turn-1',
      step: 0,
      part: { type: 'text', text: 'partial response' },
    });
    // Compaction: the in-flight assistant message survives in the tail.
    ctx.agent.context.applyCompaction(compaction('folded', 1, 300));

    const wire = persistence.records;
    const roundTripped = diskRoundTrip(wire);
    const resumed = testAgent({
      persistence: new InMemoryAgentRecordPersistence(roundTripped),
    });
    await resumed.agent.records.replay();

    // The open step must be the SAME object the history array holds, so that a
    // later content.part / tool.call lands on the visible history message and a
    // later applyCompaction can prune by reference. Note the compaction summary
    // is also an assistant-role message, so match the in-flight one by content.
    const historyInFlight = resumed.agent.context.history.find((m) =>
      m.content.some((p) => p.type === 'text' && p.text === 'partial response'),
    );
    expect(historyInFlight).toBeDefined();
    expect(resumed.agent.context.snapshot().openSteps.get('step-1')).toBe(historyInFlight);
  });

  it('handles multiple snapshots from repeated compactions', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'q1' }]);
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'q2' }]);
    ctx.agent.context.applyCompaction(compaction('summary one', 2, 100));
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'q3' }]);
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'q4' }]);
    ctx.agent.context.applyCompaction(compaction('summary two', 2, 200));
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'tail' }]);

    const liveWire = persistence.records;
    const snapshotCount = liveWire.filter((r) => r.type === 'context.snapshot').length;
    expect(snapshotCount).toBe(2);

    const withSnapshot = replayWire(liveWire);
    await withSnapshot.agent.records.replay();

    const withoutSnapshot = replayWire(
      liveWire.filter((r) => r.type !== 'context.snapshot'),
    );
    await withoutSnapshot.agent.records.replay();

    expect(withSnapshot.agent.context.data()).toEqual(withoutSnapshot.agent.context.data());
  });

  it('handles undo/clear before the snapshot identically to full replay', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'first' }]);
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'second' }]);
    ctx.agent.context.undo(1); // removes 'second'
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'third' }]);
    ctx.agent.context.applyCompaction(compaction('folded undo history', 2, 400));

    const liveWire = persistence.records;

    const withSnapshot = replayWire(liveWire);
    await withSnapshot.agent.records.replay();

    const withoutSnapshot = replayWire(
      liveWire.filter((r) => r.type !== 'context.snapshot'),
    );
    await withoutSnapshot.agent.records.replay();

    expect(withSnapshot.agent.context.data()).toEqual(withoutSnapshot.agent.context.data());
  });
});
