import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { describe, expect, it } from 'vitest';

import type { CompactionResult } from '../../../src/agent/compaction';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  FileSystemAgentRecordPersistence,
  InMemoryAgentRecordPersistence,
  type AgentRecord,
  type AgentRecordPersistence,
} from '../../../src/agent/records';
import { appendTaskOutput, writeTask } from '../../../src/tools/background/persist';
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

describe('replay-time vacuous message cleanup', () => {
  it('drops an interrupted step whose assistant message is empty after replay', async () => {
    // A turn that died mid-step persists step.begin but never step.end. The
    // replay path must drop the resulting empty assistant message, matching
    // what the live path (dropVacuousOpenMessages at turn end) retained.
    const wire: AgentRecord[] = [
      METADATA,
      userMessage('user prompt'),
      {
        type: 'context.append_loop_event',
        event: {
          type: 'step.begin',
          uuid: 'interrupted',
          turnId: 't',
          step: 0,
        },
      },
    ];

    const ctx = replayWire(wire);
    await ctx.agent.records.replay();

    expect(ctx.agent.context.history).toHaveLength(1);
    expect(ctx.agent.context.history[0]).toMatchObject({ role: 'user' });
    expect(ctx.agent.context.snapshot().openSteps.has('interrupted')).toBe(false);
  });

  it('keeps open steps with tool calls after replay', async () => {
    const wire: AgentRecord[] = [
      METADATA,
      userMessage('user prompt'),
      {
        type: 'context.append_loop_event',
        event: {
          type: 'step.begin',
          uuid: 'in-flight',
          turnId: 't',
          step: 0,
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          stepUuid: 'in-flight',
          uuid: 'in-flight',
          turnId: 't',
          step: 0,
          toolCallId: 'call_1',
          name: 'Bash',
          args: { command: 'ls' },
        },
      },
    ];

    const ctx = replayWire(wire);
    await ctx.agent.records.replay();

    // A tool-calling step is not vacuous: keep the open step and its message.
    expect(ctx.agent.context.history).toHaveLength(2);
    expect(ctx.agent.context.snapshot().openSteps.has('in-flight')).toBe(true);
  });
});


describe('delivered background notification marks across compaction', () => {
  // The delivered mark of a background-task notification is written when the
  // notification message lands in the context (`pushHistory` →
  // `markDeliveredNotification`), and rebuild on resume relies on that message
  // replaying. A full compaction folds the message into the summary and the
  // snapshot fast-path skips the append record, so the mark must survive in
  // the `context.snapshot` payload — otherwise the reopen reconcile path
  // re-delivers a notification the session already saw.
  const origin = {
    kind: 'background_task',
    taskId: 'agent-folded00',
    status: 'completed',
    notificationId: 'task:agent-folded00:completed',
  } as const;

  async function completedTaskWire(options: {
    readonly notificationDelivered: boolean;
  }): Promise<AgentRecord[]> {
    const persistence = new InMemoryAgentRecordPersistence();
    const live = testAgent({ persistence });
    live.agent.context.appendUserMessage([{ type: 'text', text: 'first question' }]);
    if (options.notificationDelivered) {
      // The delivery side effect: the notification is a history message whose
      // origin carries the delivered key.
      live.agent.context.appendUserMessage(
        [{ type: 'text', text: '<notification>folded notification</notification>' }],
        origin,
      );
    }
    live.agent.context.appendUserMessage([{ type: 'text', text: 'second question' }]);
    const count = options.notificationDelivered ? 3 : 2;
    live.agent.context.applyCompaction(compaction('summary of the pre-restart history', count, 500));
    live.agent.context.appendUserMessage([{ type: 'text', text: 'after compaction' }]);
    return persistence.records;
  }

  async function reconcileOnReopen(persistence: AgentRecordPersistence) {
    const sessionDir = await mkdtemp(join(tmpdir(), 'scream-snapshot-notify-'));
    const resumed = testAgent({ persistence });
    resumed.agent.background.attachSessionDir(sessionDir);
    await writeTask(sessionDir, {
      task_id: origin.taskId,
      command: '[agent] folded notification',
      description: 'folded notification task',
      pid: 0,
      started_at: 1_700_000_000,
      ended_at: 1_700_000_010,
      exit_code: 0,
      status: 'completed',
    });
    await appendTaskOutput(sessionDir, origin.taskId, 'already delivered summary');
    // Exactly what `Agent.resume()` does: replay the wire, load the task
    // ledger, then reconcile terminal tasks against the delivered marks.
    await resumed.agent.records.replay();
    await resumed.agent.background.loadFromDisk();
    await resumed.agent.background.reconcile();
    return { resumed, sessionDir };
  }

  it('does not re-deliver a notification the compaction folded into the summary', async () => {
    const records = await completedTaskWire({ notificationDelivered: true });

    // The snapshot written by the compaction carries the delivered key.
    const snapshotRecord = records.find((record) => record.type === 'context.snapshot');
    if (snapshotRecord?.type !== 'context.snapshot') {
      throw new Error('expected the live wire to contain a context.snapshot record');
    }
    expect(snapshotRecord.snapshot.deliveredNotificationKeys).toEqual([
      `${origin.taskId}\u0000${origin.status}\u0000${origin.notificationId}`,
    ]);

    const { resumed, sessionDir } = await reconcileOnReopen(
      new InMemoryAgentRecordPersistence(diskRoundTrip(records)),
    );
    try {
      // Reopen must not append the notification a second time.
      expect(
        resumed.agent.context.history.filter((m) => m.origin?.kind === 'background_task'),
      ).toHaveLength(0);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('restores the marks through the file-backed parse-skipping path', async () => {
    const records = await completedTaskWire({ notificationDelivered: true });
    const wireDir = await mkdtemp(join(tmpdir(), 'scream-snapshot-notify-wire-'));
    try {
      const wirePath = join(wireDir, 'wire.jsonl');
      await writeFile(
        wirePath,
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
        'utf8',
      );

      const { resumed, sessionDir } = await reconcileOnReopen(
        new FileSystemAgentRecordPersistence(wirePath),
      );
      try {
        // The production restart path: the parse-skip reader drops the folded
        // append records but keeps the snapshot line, whose payload carries the
        // delivered key — so no duplicate append here either.
        expect(
          resumed.agent.context.history.filter((m) => m.origin?.kind === 'background_task'),
        ).toHaveLength(0);
      } finally {
        await rm(sessionDir, { recursive: true, force: true });
      }
    } finally {
      await rm(wireDir, { recursive: true, force: true });
    }
  });

  it('still re-delivers a terminal notification that was never delivered', async () => {
    const records = await completedTaskWire({ notificationDelivered: false });

    const { resumed, sessionDir } = await reconcileOnReopen(
      new InMemoryAgentRecordPersistence(diskRoundTrip(records)),
    );
    try {
      const notifications = resumed.agent.context.history.filter(
        (m) => m.origin?.kind === 'background_task',
      );
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.origin).toMatchObject({
        taskId: origin.taskId,
        status: origin.status,
      });
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});

describe('file-backed resume with parse-skipping', () => {
  async function makeWirePath(): Promise<string> {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('pathe');
    return join(await mkdtemp(join(tmpdir(), 'wire-skip-test-')), 'wire.jsonl');
  }

  it('restores identical context state from file and memory', async () => {
    const { FileSystemAgentRecordPersistence } = await import(
      '../../../src/agent/records/persistence'
    );
    const { readFile, writeFile } = await import('node:fs/promises');

    // Serialize the exact in-memory wire to disk, so file and memory paths
    // replay byte-identical content.
    const wire = buildLiveWire();
    const wirePath = await makeWirePath();
    await writeFile(wirePath, wire.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    // Resume from file: parse-skipping fast path is active.
    const fromFile = testAgent({
      persistence: new FileSystemAgentRecordPersistence(wirePath),
    });
    await fromFile.agent.records.replay();

    // Resume in memory: same snapshot parse-skip rule, different persistence.
    const fromMemory = replayWire(buildLiveWire());
    await fromMemory.agent.records.replay();

    expect(fromFile.agent.context.data()).toEqual(fromMemory.agent.context.data());

    // Serialization-format lock: every line on disk starts with the "type"
    // key, which the skip probes rely on. If record shapes ever reorder keys,
    // this fails loudly instead of silently corrupting resumes.
    const raw = await readFile(wirePath, 'utf8');
    for (const line of raw.split('\n').filter((l) => l.length > 0)) {
      expect(line.startsWith('{"type":"')).toBe(true);
    }
  });
});
