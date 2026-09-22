import { describe, expect, it, vi } from 'vitest';

import { testAgent } from '../harness/agent';

describe('notifications accepted during turn teardown', () => {
  it.each(['completed', 'failed'] as const)(
    'processes %s background results without another user prompt',
    async (status) => {
      const ctx = testAgent();
      ctx.configure();
      ctx.mockNextResponse({ type: 'text', text: 'The foreground work has finished.' });
      ctx.mockNextResponse({ type: 'text', text: 'I have handled both background results.' });
      ctx.emitter.once('turn.ended', () => {
        // The last stop check has run, but the turn still owns the worker.
        expect(ctx.agent.turn.hasActiveTurn).toBe(true);
        for (const taskId of ['agent-one', 'agent-two']) {
          expect(ctx.agent.turn.steer([{ type: 'text', text: `${taskId} ${status}.` }], {
            kind: 'background_task', taskId, status,
            notificationId: `task:${taskId}:${status}`,
          })).toBeNull();
        }
      });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Finish the foreground work' }] });
      await ctx.agent.turn.waitForCurrentTurn();
      await vi.waitFor(() => {
        expect(ctx.llmCalls).toHaveLength(2);
        expect(ctx.agent.turn.hasActiveTurn).toBe(false);
      });

      const history = JSON.stringify(ctx.llmCalls[1]?.history);
      expect(history.match(new RegExp(`agent-one ${status}`, 'g'))).toHaveLength(1);
      expect(history.match(new RegExp(`agent-two ${status}`, 'g'))).toHaveLength(1);
      expect(ctx.agent.turn.steerQueueLength).toBe(0);
      expect(ctx.allEvents.filter((event) => event.event === 'turn.started')).toHaveLength(2);
    },
  );

  it('processes a late notification after a goal-driven run releases its worker', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['TodoList'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.agent.goal.createGoal({ objective: 'Finish the foreground work' });
    ctx.mockNextResponse({
      type: 'function', id: 'todo_finished', name: 'TodoList',
      arguments: JSON.stringify({ todos: [{ title: 'Foreground work', status: 'done' }] }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'The foreground goal has finished.' });
    ctx.mockNextResponse({ type: 'text', text: 'I have handled the background result.' });
    ctx.emitter.once('turn.ended', () => {
      void ctx.agent.goal.markComplete();
      ctx.agent.turn.steer([{ type: 'text', text: 'A late background result.' }], {
        kind: 'background_task', taskId: 'agent-one', status: 'completed',
        notificationId: 'task:agent-one:completed',
      });
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Finish the goal' }] });
    await ctx.agent.turn.waitForCurrentTurn();
    await vi.waitFor(() => {
      expect(ctx.llmCalls).toHaveLength(3);
      expect(ctx.agent.turn.hasActiveTurn).toBe(false);
    });

    expect(JSON.stringify(ctx.llmCalls[2]?.history)).toContain('A late background result.');
    expect(ctx.agent.turn.steerQueueLength).toBe(0);
    expect(ctx.agent.goal.getGoal().goal).toBeNull();
  });

  it.each(['before release', 'after release'] as const)(
    'does not automatically resume when cancelled %s during teardown',
    async (timing) => {
      const ctx = testAgent();
      ctx.configure();
      ctx.mockNextResponse({ type: 'text', text: 'The foreground work has finished.' });
      ctx.emitter.once('turn.ended', () => {
        ctx.agent.turn.steer([{ type: 'text', text: 'A late background result.' }], {
          kind: 'background_task', taskId: 'agent-one', status: 'completed',
          notificationId: 'task:agent-one:completed',
        });
        if (timing === 'before release') ctx.agent.turn.cancel();
        else queueMicrotask(() => ctx.agent.turn.cancel());
      });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Finish the foreground work' }] });
      await ctx.agent.turn.waitForCurrentTurn();

      expect(ctx.llmCalls).toHaveLength(1);
      expect(ctx.agent.turn.hasActiveTurn).toBe(false);
      expect(ctx.agent.turn.steerQueueLength).toBe(1);
    },
  );

  it('lets a newer user turn consume the result without starting a competing turn', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'The foreground work has finished.' });
    ctx.mockNextResponse({ type: 'text', text: 'I handled the new request and the background result.' });
    ctx.emitter.once('turn.ended', () => {
      ctx.agent.turn.steer([{ type: 'text', text: 'A late background result.' }], {
        kind: 'background_task', taskId: 'agent-one', status: 'completed',
        notificationId: 'task:agent-one:completed',
      });
      queueMicrotask(() => {
        ctx.agent.turn.prompt([{ type: 'text', text: 'A new user request.' }]);
      });
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Finish the foreground work' }] });
    await ctx.agent.turn.waitForCurrentTurn();
    await vi.waitFor(() => {
      expect(ctx.llmCalls).toHaveLength(2);
      expect(ctx.agent.turn.hasActiveTurn).toBe(false);
    });

    const history = JSON.stringify(ctx.llmCalls[1]?.history);
    expect(history).toContain('A new user request.');
    expect(history).toContain('A late background result.');
    expect(ctx.agent.turn.steerQueueLength).toBe(0);
    expect(ctx.allEvents.filter((event) => event.event === 'turn.started')).toMatchObject([
      { args: { origin: { kind: 'user' } } },
      { args: { origin: { kind: 'user' } } },
    ]);
  });
});
