import { describe, expect, it } from 'vitest';
import { applySubagentActivityEvent } from '../../src/web/frontend/src/utils/subagentActivity';

describe('applySubagentActivityEvent', () => {
  it('folds a spawned, started, and completed lifecycle into one activity', () => {
    let activities = applySubagentActivityEvent([], {
      type: 'subagent.spawned',
      subagentId: 'agent-1',
      subagentName: 'explore',
      parentToolCallId: 'call-1',
      description: 'Inspect the repository',
      runInBackground: false,
    }, 100);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      subagentId: 'agent-1',
      name: 'explore',
      description: 'Inspect the repository',
      state: 'spawning',
      updatedAt: 100,
    });

    activities = applySubagentActivityEvent(activities, {
      type: 'subagent.started',
      subagentId: 'agent-1',
      parentToolCallId: 'call-1',
      runInBackground: false,
    }, 200);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ state: 'running', description: 'Inspect the repository' });

    activities = applySubagentActivityEvent(activities, {
      type: 'subagent.completed',
      subagentId: 'agent-1',
      parentToolCallId: 'call-1',
      resultSummary: 'Found the relevant modules.',
      usage: { inputOther: 10, output: 20, inputCacheRead: 3, inputCacheCreation: 2 },
      contextTokens: 128,
      turns: 2,
      durationMs: 1_250,
      toolCallCount: 4,
    }, 300);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      state: 'completed',
      resultSummary: 'Found the relevant modules.',
      contextTokens: 128,
      turns: 2,
      durationMs: 1_250,
      toolCallCount: 4,
      usage: { inputOther: 10, output: 20, inputCacheRead: 3, inputCacheCreation: 2 },
    });
  });

  it('creates a replay-safe failed activity when the spawn frame was pruned', () => {
    const activities = applySubagentActivityEvent([], {
      type: 'subagent.failed',
      subagentId: 'agent-lost',
      parentToolCallId: 'call-2',
      error: 'aborted',
      usage: { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
    }, 400);
    expect(activities).toEqual([expect.objectContaining({
      subagentId: 'agent-lost',
      name: 'agent',
      state: 'failed',
      error: 'aborted',
      runInBackground: false,
      updatedAt: 400,
    })]);
  });

  it('keeps active agents first and retains only the newest 24 entries', () => {
    const completed = Array.from({ length: 25 }, (_, index) => ({
      type: 'subagent.completed',
      subagentId: `done-${index}`,
      parentToolCallId: `call-${index}`,
      resultSummary: `done ${index}`,
    }));
    let activities = completed.reduce(
      (current, event, index) => applySubagentActivityEvent(current, event, index),
      [],
    );
    activities = applySubagentActivityEvent(activities, {
      type: 'subagent.started',
      subagentId: 'active',
      parentToolCallId: 'active-call',
      runInBackground: true,
    }, 1000);
    expect(activities).toHaveLength(24);
    expect(activities[0]).toMatchObject({ subagentId: 'active', state: 'running' });
    expect(activities.some((item) => item.subagentId === 'done-0')).toBe(false);
  });

  it('ignores unrelated frames without changing the current reference', () => {
    const current = [];
    expect(applySubagentActivityEvent(current, { type: 'assistant.delta', delta: 'hi' })).toBe(current);
    expect(applySubagentActivityEvent(current, { type: 'subagent.started' })).toBe(current);
  });
});
