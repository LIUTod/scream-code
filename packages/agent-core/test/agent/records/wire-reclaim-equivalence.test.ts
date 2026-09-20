import { describe, expect, it } from 'vitest';

import {
  InMemoryAgentRecordPersistence,
  type AgentRecord,
} from '../../../src/agent/records';
import { SNAPSHOT_FOLDED_CONTEXT_TYPES } from '../../../src/agent/records/persistence';
import { testAgent } from '../harness/agent';

/**
 * Physically drop every record `read()`/`compact()` reclaims, mirroring the two
 * rules in `persistence.ts`:
 *
 *  1. a record whose type is in `foldedTypes` and that predates the LAST
 *     `context.snapshot` (the last snapshot itself is never dropped, matching
 *     `keepLine()`'s `index < lastSnapshotIndex`); and
 *  2. every `context.stream_draft` that is NOT the last draft of its turnId —
 *     independent of any snapshot, because restore replaces a turn's draft in
 *     place (`ReplayBuilder.replacePartialDraft`) so only the last one is
 *     observable.
 *
 * `foldedTypes` defaults to the IMPLEMENTATION's exported set, so this test
 * measures the wire the implementation actually produces; the per-test sanity
 * assertions below then pin which records that must have removed, which is what
 * makes the test fail when either rule regresses.
 */
function reclaim(
  wire: readonly AgentRecord[],
  foldedTypes: ReadonlySet<string> = SNAPSHOT_FOLDED_CONTEXT_TYPES,
): { kept: AgentRecord[]; dropped: AgentRecord[] } {
  const lastDraftIndex = new Map<string, number>();
  wire.forEach((record, index) => {
    if (record.type === 'context.stream_draft') lastDraftIndex.set(record.turnId, index);
  });
  let lastSnapshotIndex = -1;
  for (let i = wire.length - 1; i >= 0; i--) {
    if (wire[i]?.type === 'context.snapshot') {
      lastSnapshotIndex = i;
      break;
    }
  }
  const kept: AgentRecord[] = [];
  const dropped: AgentRecord[] = [];
  wire.forEach((record, index) => {
    if (
      record.type === 'context.stream_draft' &&
      lastDraftIndex.get(record.turnId) !== index
    ) {
      dropped.push(record);
      return;
    }
    if (lastSnapshotIndex !== -1 && index < lastSnapshotIndex && foldedTypes.has(record.type)) {
      dropped.push(record);
      return;
    }
    kept.push(record);
  });
  return { kept, dropped };
}

function diskRoundTrip(records: readonly AgentRecord[]): AgentRecord[] {
  return JSON.parse(JSON.stringify(records)) as AgentRecord[];
}

/** Resume an agent from a wire and snapshot everything the resume must reproduce. */
async function observe(wire: readonly AgentRecord[]) {
  const ctx = testAgent({
    persistence: new InMemoryAgentRecordPersistence(diskRoundTrip(wire)),
  });
  await ctx.agent.records.replay();
  return {
    history: ctx.agent.context.history,
    replay: ctx.agent.replayBuilder.buildResult(),
    compactedHistory: ctx.agent.fullCompaction.compactedHistory,
    // `deliveredNotificationKeys` is private, but the delivered-notification set
    // is the only observable effect of the snapshot branch's background
    // marking, so read it through a cast instead of leaving that dimension
    // unverified.
    deliveredNotifications: [
      ...(ctx.agent.background as unknown as { deliveredNotificationKeys: Set<string> })
        .deliveredNotificationKeys,
    ].toSorted(),
  };
}

function textOf(record: { readonly type: string } & Record<string, unknown>): string {
  if (record.type === 'message') {
    const message = record['message'] as {
      content: readonly { type: string; text?: string }[];
    };
    return message.content
      .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
      .join('');
  }
  return record.type;
}

const draft = (turnId: string, text: string, think = ''): AgentRecord => ({
  type: 'context.stream_draft',
  turnId,
  text,
  think,
});

/** The wire stamps every record with `time`; drop it for shape comparisons. */
function stripTime(record: AgentRecord): Record<string, unknown> {
  const { time: _time, ...rest } = record as AgentRecord & { time?: number };
  return rest;
}

/**
 * The wire a live session produces: two full compactions (each writing a
 * `context.snapshot`), crash-recovery stream drafts around them, and a
 * background-task notification message folded into the second snapshot.
 *
 * Draft shapes covered, all of them produced by the live path
 * (agent/turn/index.ts onStreamingDraft + loop/turn-step.ts StreamDraftTracker):
 *  - several throttled drafts for one turn, then the empty "cleared" marker the
 *    live path writes once real content parts land;
 *  - a turn whose draft sequence straddles the second snapshot boundary;
 *  - an uncleared draft after the last snapshot (process died mid-stream).
 */
function buildLiveWire(): AgentRecord[] {
  const persistence = new InMemoryAgentRecordPersistence();
  const ctx = testAgent({ persistence });
  const push = (record: AgentRecord): void => {
    ctx.dispatch(record);
  };
  const compaction = (summary: string, tokensAfter: number): void => {
    ctx.agent.context.applyCompaction({
      summary,
      compactedCount: 2,
      tokensBefore: 1_000,
      tokensAfter,
    });
  };

  // ── Turn 1: throttled drafts, then the cleared marker ───────────────
  ctx.agent.context.appendUserMessage([{ type: 'text', text: 'q1' }]);
  ctx.agent.context.appendUserMessage([{ type: 'text', text: 'q2' }]);
  push(draft('1', 'partial one'));
  push(draft('1', 'partial one + two', 'thinking'));
  push(draft('1', ''));

  // ── Full compaction #1 → snapshot S1 ───────────────────────────────
  compaction('summary one', 100);

  // ── Post-S1 traffic, including a background-task notification ───────
  ctx.agent.context.appendUserMessage([{ type: 'text', text: 'q3' }]);
  ctx.agent.context.appendUserMessage([{ type: 'text', text: 'bg done' }], {
    kind: 'background_task',
    taskId: 'bash-1',
    status: 'completed',
    notificationId: 'task:bash-1:completed',
  });

  // ── Turn 2 straddles S2: drafts + clear before, a draft after ───────
  push(draft('2', 'draft two a'));
  push(draft('2', 'draft two b'));
  push(draft('2', ''));
  ctx.agent.context.appendUserMessage([{ type: 'text', text: 'q4' }]);

  // ── Full compaction #2 → snapshot S2 (trail is a superset of S1's) ──
  compaction('summary two', 90);
  push(draft('2', 'draft two c'));

  // ── Turn 3 dies mid-stream after S2 (uncleared draft) ───────────────
  ctx.agent.context.appendUserMessage([{ type: 'text', text: 'q5' }]);
  push(draft('3', 'crashed mid-stream', 'crashed think'));

  return persistence.records;
}

/**
 * The drafts the implementation MUST reclaim: every draft that is not the LAST
 * one of its turnId. Turn 1's last draft is its cleared marker (kept); turn 2's
 * last draft is the post-S2 `draft two c`, so its earlier drafts — including the
 * cleared marker before S2 — are reclaimed.
 */
const INTERMEDIATE_DRAFTS: readonly AgentRecord[] = [
  draft('1', 'partial one'),
  draft('1', 'partial one + two', 'thinking'),
  draft('2', 'draft two a'),
  draft('2', 'draft two b'),
  draft('2', ''),
];

/** Every turn's LAST draft survives: that is the one restore can observe. */
const LAST_DRAFT_PER_TURN: readonly AgentRecord[] = [
  draft('1', ''),
  draft('2', 'draft two c'),
  draft('3', 'crashed mid-stream', 'crashed think'),
];

describe('wire reclaim equivalence', () => {
  it('builds a wire with two snapshots and drafts on both sides of the last one', () => {
    const wire = buildLiveWire();
    const types = wire.map((record) => record.type);
    const lastSnapshotIndex = types.lastIndexOf('context.snapshot');
    expect(types.filter((type) => type === 'context.snapshot')).toHaveLength(2);
    expect(types.filter((type) => type === 'context.stream_draft')).toHaveLength(8);
    expect(types.slice(0, lastSnapshotIndex)).toContain('context.stream_draft');
    expect(types.slice(lastSnapshotIndex + 1)).toContain('context.stream_draft');
  });

  it('reclaiming intermediate drafts preserves history, replay log, compaction trail and background marks', async () => {
    const wire = buildLiveWire();
    const { kept, dropped } = reclaim(wire);

    // Implementation-sensitivity: reclaiming MUST have removed exactly the
    // intermediate drafts — every turn's last draft survives. If the per-turn
    // retention rule regresses, `dropped` loses the drafts and this fails
    // instead of the test passing vacuously.
    expect(dropped.filter((record) => record.type === 'context.stream_draft').map(stripTime)).toEqual(
      INTERMEDIATE_DRAFTS,
    );
    expect(kept.filter((record) => record.type === 'context.stream_draft').map(stripTime)).toEqual(
      LAST_DRAFT_PER_TURN,
    );

    const full = await observe(wire);
    const reclaimed = await observe(kept);

    // Tie the helper to the IMPLEMENTATION: reading the un-reclaimed wire must
    // yield exactly the records this test computed as "kept". Without this the
    // test would pass even if the implementation's retention rule regressed,
    // because `kept` is produced by the helper rather than by the code under
    // test (the byte-level rule is covered separately by wire-reclaim.test.ts).
    const implementationKept: string[] = [];
    for await (const record of new InMemoryAgentRecordPersistence(wire).read()) {
      implementationKept.push(JSON.stringify(record));
    }
    expect(implementationKept).toEqual(kept.map((record) => JSON.stringify(record)));

    expect(JSON.stringify(reclaimed.history)).toBe(JSON.stringify(full.history));
    expect(JSON.stringify(reclaimed.replay)).toBe(JSON.stringify(full.replay));
    expect(JSON.stringify(reclaimed.compactedHistory)).toBe(
      JSON.stringify(full.compactedHistory),
    );
    expect(reclaimed.deliveredNotifications).toEqual(full.deliveredNotifications);

    // The uncleared drafts that survive (turn 2's last draft, turn 3's crashed
    // stream) still surface as partial records, byte-identical to the
    // un-reclaimed wire; the reclaimed intermediate drafts were never visible.
    expect(
      reclaimed.replay.filter((record) => record.type === 'stream_draft_partial'),
    ).toEqual(full.replay.filter((record) => record.type === 'stream_draft_partial'));
    expect(
      reclaimed.replay.filter((record) => record.type === 'stream_draft_partial'),
    ).toEqual([
      { type: 'stream_draft_partial', turnId: '2', text: 'draft two c', think: '' },
      {
        type: 'stream_draft_partial',
        turnId: '3',
        text: 'crashed mid-stream',
        think: 'crashed think',
      },
    ]);
  });

  it('keeps a turn whose only draft predates the last snapshot (it is still that turn last draft)', async () => {
    // The one shape where a blanket "fold every pre-snapshot draft" rule would
    // silently change resume output: an aborted stream whose draft was never
    // cleared, followed by a compaction. Per-turn retention keeps it, so resume
    // still shows the incomplete reply — byte-identical to the un-reclaimed wire.
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'q1' }]);
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'q2' }]);
    ctx.dispatch(draft('7', 'cut mid-part'));
    ctx.agent.context.applyCompaction({
      summary: 'summary seven',
      compactedCount: 2,
      tokensBefore: 1_000,
      tokensAfter: 100,
    });
    const wire = persistence.records;

    const { kept, dropped } = reclaim(wire);
    // No draft is reclaimable here: this is turn 7's LAST draft. (Other record
    // types — messages, compaction records — may still be folded.)
    expect(dropped.filter((record) => record.type === 'context.stream_draft')).toHaveLength(0);
    expect(kept.filter((record) => record.type === 'context.stream_draft')).toEqual(
      wire.filter((record) => record.type === 'context.stream_draft'),
    );

    const full = await observe(wire);
    const reclaimed = await observe(kept);

    expect(JSON.stringify(reclaimed.history)).toBe(JSON.stringify(full.history));
    expect(JSON.stringify(reclaimed.replay)).toBe(JSON.stringify(full.replay));
    expect(JSON.stringify(reclaimed.compactedHistory)).toBe(
      JSON.stringify(full.compactedHistory),
    );
    expect(reclaimed.deliveredNotifications).toEqual(full.deliveredNotifications);
    // The partial marker survives: this draft is turn 7's LAST draft, so it is
    // never reclaimed — exactly the behaviour a blanket fold would have broken.
    expect(full.replay.filter((record) => record.type === 'stream_draft_partial')).toEqual([
      { type: 'stream_draft_partial', turnId: '7', text: 'cut mid-part', think: '' },
    ]);
    expect(reclaimed.replay.filter((record) => record.type === 'stream_draft_partial')).toEqual(
      full.replay.filter((record) => record.type === 'stream_draft_partial'),
    );
  });

  it('MEASUREMENT: reclaiming pre-snapshot snapshots is NOT replay-equivalent', async () => {
    const wire = buildLiveWire();
    const { kept } = reclaim(
      wire,
      new Set([...SNAPSHOT_FOLDED_CONTEXT_TYPES, 'context.snapshot']),
    );
    const full = await observe(wire);
    const reclaimed = await observe(kept);

    // Folded context state, compaction trail and background marks are identical...
    expect(JSON.stringify(reclaimed.history)).toBe(JSON.stringify(full.history));
    expect(JSON.stringify(reclaimed.compactedHistory)).toBe(
      JSON.stringify(full.compactedHistory),
    );
    expect(reclaimed.deliveredNotifications).toEqual(full.deliveredNotifications);

    // ...but the replay log is NOT: `restore()` really runs the skipped
    // snapshot's branch, whose history loop pushes that (stale) history into the
    // replay log (records/index.ts `context.snapshot` case). Reclaiming the
    // snapshot removes those records from the resumed UI's replay window.
    const fullLabels = full.replay.map((record) => textOf(record));
    const reclaimedLabels = reclaimed.replay.map((record) => textOf(record));
    expect(reclaimedLabels).not.toEqual(fullLabels);
    expect(fullLabels).toContain('summary one');
    expect(reclaimedLabels).not.toContain('summary one');
    expect(reclaimedLabels).toEqual(fullLabels.filter((label) => label !== 'summary one'));
  });
});
