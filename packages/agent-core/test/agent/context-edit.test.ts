import { describe, expect, it } from 'vitest';

import type { Message } from '@scream-code/ltod';
import { DEFAULT_COMPACTION_CONFIG, DefaultCompactionStrategy } from '../../src/agent/compaction';
import { InMemoryAgentRecordPersistence } from '../../src/agent/records';
import { testAgent } from './harness/agent';

function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

describe('context projection edits', () => {
  it('assigns a stable id to every history message', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'one' }]);
    ctx.agent.context.appendMessage(assistantText('two'));

    const ids = ctx.agent.context.history.map((message) => message.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(id).toMatch(/^m\d+$/);
    }
    expect(new Set(ids).size).toBe(2);
  });

  it('removes an edited message from the projection but keeps the raw history', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'keep me' }]);
    ctx.agent.context.appendMessage(assistantText('noise'));
    const noiseId = ctx.agent.context.history[1]!.id!;

    ctx.agent.context.applyMessageEdit(noiseId, null);

    // Raw history (UI, export, trace, resume) is untouched.
    expect(ctx.agent.context.history).toHaveLength(2);
    expect(ctx.agent.context.history[1]!.content).toEqual([{ type: 'text', text: 'noise' }]);
    // Projection (what the model sees) drops it.
    expect(ctx.agent.context.messages.map((message) => message.role)).toEqual(['user']);
  });

  it('replaces content in the projection only', () => {
    const ctx = testAgent();
    ctx.configure();
    const original = 'x'.repeat(400);
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'hi' }]);
    ctx.agent.context.appendMessage(assistantText(original));
    const assistantId = ctx.agent.context.history[1]!.id!;

    ctx.agent.context.applyMessageEdit(assistantId, [{ type: 'text', text: 'condensed' }]);

    expect(ctx.agent.context.messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'condensed' }],
    });
    expect(ctx.agent.context.history[1]!.content).toEqual([{ type: 'text', text: original }]);
  });

  it('lets a later edit override an earlier one (last write wins)', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'hi' }]);
    ctx.agent.context.appendMessage(assistantText('first version'));
    const id = ctx.agent.context.history[1]!.id!;

    ctx.agent.context.applyMessageEdit(id, null);
    ctx.agent.context.applyMessageEdit(id, [{ type: 'text', text: 'second version' }]);

    expect(ctx.agent.context.messages[1]).toMatchObject({
      content: [{ type: 'text', text: 'second version' }],
    });
  });

  it('rejects edits for unknown targets while live', () => {
    const ctx = testAgent();
    ctx.configure();
    expect(() => {
      ctx.agent.context.applyMessageEdit('m404', null);
    }).toThrow(/no message with id/);
  });

  it('refuses to edit compaction summaries', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'a' }]);
    ctx.agent.context.applyCompaction({
      summary: 'SUMMARY',
      compactedCount: 0,
      tokensBefore: 10,
      tokensAfter: 1,
    });
    const summaryId = ctx.agent.context.history[0]!.id!;

    expect(() => {
      ctx.agent.context.applyMessageEdit(summaryId, null);
    }).toThrow(/not editable/);
  });

  it('records each edit on the wire', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'a' }]);
    const id = ctx.agent.context.history[0]!.id!;

    ctx.agent.context.applyMessageEdit(id, null);
    await ctx.agent.records.flush();

    const edits = persistence.records.filter((record) => record.type === 'context.edit_message');
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ targetId: id, replacement: null });
  });

  it('replays edits on resume (projection and history both stable)', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'keep me' }]);
    ctx.agent.context.appendMessage(assistantText('noise'));
    const noiseId = ctx.agent.context.history[1]!.id!;
    ctx.agent.context.applyMessageEdit(noiseId, [{ type: 'text', text: 'condensed' }]);

    await ctx.expectResumeMatches();
  });

  it('keeps edits when a full compaction folds them into the snapshot', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'keep me' }]);
    ctx.agent.context.appendMessage(assistantText('noise'));
    const noiseId = ctx.agent.context.history[1]!.id!;
    ctx.agent.context.applyMessageEdit(noiseId, null);
    // A compaction writes `context.snapshot`, whose payload must carry the
    // edits so wires that fold the edit record still restore the projection.
    ctx.agent.context.applyCompaction({
      summary: 'SUMMARY',
      compactedCount: 1,
      tokensBefore: 50,
      tokensAfter: 5,
    });
    await ctx.agent.records.flush();

    const types = persistence.records.map((record) => record.type);
    expect(types).toContain('context.snapshot');
    expect(types).toContain('context.edit_message');

    await ctx.expectResumeMatches();
  });

  it('carries edits through the JSON snapshot', () => {
    const source = testAgent();
    source.configure();
    source.agent.context.appendUserMessage([{ type: 'text', text: 'keep me' }]);
    source.agent.context.appendMessage(assistantText('noise'));
    const noiseId = source.agent.context.history[1]!.id!;

    const beforeEdit = source.agent.context.toJSONSnapshot();
    source.agent.context.applyMessageEdit(noiseId, null);
    const afterEdit = source.agent.context.toJSONSnapshot();

    // A snapshot taken before the edit restores without it (legacy wires).
    const legacy = testAgent();
    legacy.configure();
    legacy.agent.context.restoreJSONSnapshot(beforeEdit);
    expect(legacy.agent.context.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(legacy.agent.context.history.map((message) => message.id)).toEqual(
      source.agent.context.history.map((message) => message.id),
    );

    // A snapshot taken after the edit restores the projection edit.
    const restored = testAgent();
    restored.configure();
    restored.agent.context.restoreJSONSnapshot(afterEdit);
    expect(restored.agent.context.messages.map((message) => message.role)).toEqual(['user']);
  });

  it('adjusts the measured token count when an edit lands inside the covered prefix', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.appendExchange(1, 'y'.repeat(2000), 'ok', 600);
    const userId = ctx.agent.context.history[0]!.id!;
    const before = ctx.agent.context.tokenCountWithPending;

    ctx.agent.context.applyMessageEdit(userId, null);

    expect(ctx.agent.context.tokenCountWithPending).toBeLessThan(before);
  });

  it('drops edited-out messages from the compaction cut budget', () => {
    const strategy = new DefaultCompactionStrategy(() => 1_000_000, {
      ...DEFAULT_COMPACTION_CONFIG,
    });
    const text = 'x'.repeat(20_000);
    const messages: Message[] = Array.from({ length: 30 }, () => ({
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    }));

    const baseline = strategy.computeCompactCount(messages, 'auto');
    const removedTail = new Set<Message>(messages.slice(24));
    const withEdits = strategy.computeCompactCount(messages, 'auto', {
      isRemoved: (message) => removedTail.has(message),
    });

    expect(baseline).toBeGreaterThan(0);
    expect(withEdits).toBeLessThan(baseline);
  });

  it('re-anchors applyCompaction by firstKeptMessageId', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'a' }]);
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'b' }]);
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'c' }]);
    const keepId = ctx.agent.context.history[2]!.id!;

    ctx.agent.context.applyCompaction({
      summary: 'SUMMARY',
      compactedCount: 0, // deliberately wrong: identity must win over the index
      firstKeptMessageId: keepId,
      tokensBefore: 100,
      tokensAfter: 10,
    });

    const history = ctx.agent.context.history;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ origin: { kind: 'compaction_summary' } });
    expect(history[1]).toMatchObject({ content: [{ type: 'text', text: 'c' }] });
  });

  it('replaces (not stacks) the gauge delta when the same message is edited twice', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.appendExchange(1, 'y'.repeat(2000), 'ok', 600);
    const userId = ctx.agent.context.history[0]!.id!;
    const baseline = ctx.agent.context.tokenCountWithPending;

    ctx.agent.context.applyMessageEdit(userId, null);
    const removed = ctx.agent.context.tokenCountWithPending;
    ctx.agent.context.applyMessageEdit(userId, [{ type: 'text', text: 'tiny' }]);
    const restored = ctx.agent.context.tokenCountWithPending;

    // Removing then re-adding a *tiny* replacement must land as `baseline −
    // big + tiny`: above the removed gauge (content came back) but well below
    // the original. A stacking bug would subtract the original again and push
    // it below `removed`.
    expect(removed).toBeLessThan(baseline);
    expect(restored).toBeGreaterThan(removed);
    expect(restored).toBeLessThan(baseline);
  });

  it('accepts edits for deferred messages (ids survive snapshot restore)', () => {
    const source = testAgent();
    source.configure();
    const snapshot = source.agent.context.toJSONSnapshot();
    const withDeferred = {
      ...snapshot,
      deferredMessages: [
        {
          id: 'm42',
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'deferred note' }],
          toolCalls: [],
          origin: { kind: 'user' as const },
        },
      ],
    };

    const restored = testAgent();
    restored.configure();
    restored.agent.context.restoreJSONSnapshot(withDeferred);

    // Deferred messages are addressable even though they are not in the
    // history yet: the edit replays against the id and applies once flushed.
    expect(() => {
      restored.agent.context.applyMessageEdit('m42', null);
    }).not.toThrow();
  });

  it('never resurrects an edited-out message through adjacent-user merging', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'PREFIX-ONE' }]);
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'PREFIX-TWO' }]);
    const secondId = ctx.agent.context.history[1]!.id!;

    ctx.agent.context.applyMessageEdit(secondId, null);

    const projection = JSON.stringify(ctx.agent.context.messages);
    expect(projection).not.toContain('PREFIX-TWO');
  });
});
